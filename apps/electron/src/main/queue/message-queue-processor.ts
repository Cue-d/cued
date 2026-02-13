/**
 * MessageQueueProcessor for Electron.
 * Subscribes to the Convex message queue and routes messages to platform adapters.
 *
 * Key features:
 * - Reactive WebSocket subscription to getQueuedMessages for messages ready to send
 * - Routes messages to appropriate adapters (iMessage, LinkedIn)
 * - Handles retries with exponential backoff
 * - Updates message status in Convex after send attempts
 */
import { api } from "@cued/convex";
import type { Id, Doc } from "@cued/convex";
import type { ActionPlatform, QueuedMessage } from "@cued/shared";
import {
  getConvexClient,
  type Unsubscribe,
} from "../convex-client.js";
import { getAdapter, SERVER_SIDE_PLATFORMS } from "../adapters/index.js";

/** Maximum concurrent sends to prevent overload */
const MAX_CONCURRENT_SENDS = 5;
/** Fallback poll interval in case subscription updates are missed */
const FALLBACK_POLL_INTERVAL_MS = 10000;

/**
 * MessageQueueProcessor handles sending messages from the unified queue.
 *
 * Uses reactive WebSocket subscription to Convex for real-time updates.
 */
/** Delay before retrying messages that failed due to auth (5 seconds) */
const AUTH_RETRY_DELAY_MS = 5000;

/** Maximum auth retries before giving up on a message */
const MAX_AUTH_RETRIES = 6; // 30 seconds total

export class MessageQueueProcessor {
  private subscription: Unsubscribe<{ messages: Doc<"messageQueue">[] }> | null = null;
  private fallbackPollInterval: NodeJS.Timeout | null = null;
  private processingIds = new Set<string>();
  private authRetryCount = new Map<string, number>();
  private stopped = false;
  private deviceId: string = `electron-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  /**
   * Start processing the message queue.
   * Subscribes to getQueuedMessages for real-time updates via WebSocket.
   */
  start(): void {
    if (this.subscription) {
      return;
    }

    this.stopped = false;
    const client = getConvexClient();

    console.log("[MessageQueueProcessor] Starting WebSocket subscription...");

    // Subscribe to messages ready to send
    this.subscription = client.subscribe(
      api.messageQueue.getQueuedMessages,
      { limit: 20 },
      (result) => {
        if (result.messages.length > 0) {
          console.log(
            `[MessageQueueProcessor] Subscription update: ${result.messages.length} messages ready`
          );
        }
        this.handleQueueUpdate(result.messages);
      },
      (error) => {
        console.error("[MessageQueueProcessor] Subscription error:", error);
        this.handleSubscriptionError();
      }
    );

    // Do an initial poll after a short delay to catch any pending messages
    // This handles the case where messages were queued while the app was closed
    setTimeout(() => this.pollOnce("startup"), 2000);

    if (!this.fallbackPollInterval) {
      this.fallbackPollInterval = setInterval(() => {
        if (!this.stopped) {
          this.pollOnce("fallback");
        }
      }, FALLBACK_POLL_INTERVAL_MS);
      console.log(
        `[MessageQueueProcessor] Fallback polling enabled (${FALLBACK_POLL_INTERVAL_MS}ms interval)`
      );
    }
  }

  /**
   * Poll once for pending messages.
   * Used on startup to process any backlog.
   */
  async pollOnce(source: "startup" | "fallback" = "startup"): Promise<void> {
    if (this.stopped) return;

    try {
      const client = getConvexClient();
      const result = await client.query(api.messageQueue.getQueuedMessages, { limit: 20 });
      if (result.messages.length > 0 || source === "startup") {
        console.log(
          `[MessageQueueProcessor] ${source} poll found ${result.messages.length} pending messages`
        );
      }
      if (result.messages.length > 0) {
        await this.handleQueueUpdate(result.messages);
      }
    } catch (error) {
      console.error(`[MessageQueueProcessor] ${source} poll failed:`, error);
    }
  }

  /**
   * Stop processing the message queue.
   */
  stop(): void {
    this.stopped = true;

    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }
    if (this.fallbackPollInterval) {
      clearInterval(this.fallbackPollInterval);
      this.fallbackPollInterval = null;
    }
  }

  /**
   * Handle subscription errors with reconnection.
   */
  private handleSubscriptionError(): void {
    if (this.stopped) return;

    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }

    // Retry after delay
    setTimeout(() => {
      if (!this.stopped) {
        console.log("[MessageQueueProcessor] Reconnecting...");
        this.start();
      }
    }, 5000);
  }

  /**
   * Handle queue update from the subscription.
   * Processes new messages that aren't already being processed.
   */
  private async handleQueueUpdate(messages: Doc<"messageQueue">[]): Promise<void> {
    if (this.stopped || messages.length === 0) return;

    // Filter to messages not already being processed
    const newMessages = messages.filter(
      (m) => !this.processingIds.has(m._id)
    );
    if (newMessages.length === 0) return;

    // Process messages with concurrency limit
    const batch = newMessages.slice(0, MAX_CONCURRENT_SENDS);
    await Promise.all(batch.map((m) => this.processMessage(m)));
  }

  /**
   * Process a single message from the queue.
   */
  private async processMessage(message: Doc<"messageQueue">): Promise<void> {
    const messageId = message._id;

    // Mark as processing to prevent duplicate sends
    if (this.processingIds.has(messageId)) return;
    this.processingIds.add(messageId);

    let keepInProcessing = false;
    try {
      // Skip server-side platforms
      if (SERVER_SIDE_PLATFORMS.includes(message.platform as ActionPlatform)) {
        return;
      }

      // Claim the message (single-sender lock for multi-device)
      const client = getConvexClient();
      const claimResult = await client.mutation(api.messageQueue.claimMessage, {
        messageId,
        deviceId: this.deviceId,
      });
      if (!claimResult.success) {
        console.log(`[MessageQueueProcessor] Claim failed for ${messageId}: ${claimResult.reason}`);
        return;
      }

      // Get the adapter for this platform
      const adapter = getAdapter(message.platform as ActionPlatform);
      if (!adapter) {
        console.error(`[MessageQueueProcessor] No adapter for platform: ${message.platform}`);
        await this.updateStatus(messageId, "failed", `No adapter for platform: ${message.platform}`);
        return;
      }

      // Check if adapter is authenticated
      const isAuth = await adapter.isAuthenticated();
      if (!isAuth) {
        const retryCount = this.authRetryCount.get(messageId) ?? 0;
        if (retryCount < MAX_AUTH_RETRIES) {
          this.authRetryCount.set(messageId, retryCount + 1);
          // Keep in processingIds so subscription updates don't re-enter
          // before the delayed retry fires. The setTimeout handles cleanup.
          keepInProcessing = true;
          setTimeout(() => {
            this.processingIds.delete(messageId);
            void this.pollOnce("fallback");
          }, AUTH_RETRY_DELAY_MS);
          return;
        }
        console.warn(`[MessageQueueProcessor] ${message.platform} not authenticated after ${MAX_AUTH_RETRIES} retries`);
        this.authRetryCount.delete(messageId);
        await this.updateStatus(
          messageId,
          "failed",
          `${message.platform} is not authenticated in the desktop app`
        );
        return;
      }

      // Clear retry count on successful auth
      this.authRetryCount.delete(messageId);

      const sendingTransition = await this.updateStatus(messageId, "sending");
      if (!sendingTransition.success) {
        if (sendingTransition.reason === "conversation_locked") {
          console.log(
            `[MessageQueueProcessor] Conversation locked for ${messageId}; waiting for earlier message to finish`
          );
        } else {
          console.log(
            `[MessageQueueProcessor] Skipping send for ${messageId}: sending transition was rejected (${sendingTransition.reason ?? "unknown"})`
          );
        }
        return;
      }

      // Convert to QueuedMessage format expected by adapters
      const queuedMessage: QueuedMessage = {
        id: messageId,
        platform: message.platform as ActionPlatform,
        recipientHandle: message.recipientHandle,
        text: message.text,
        threadId: message.chatIdentifier,
        groupHandles: message.isGroup ? [message.recipientHandle] : undefined,
        workspaceId: message.workspaceId,
      };

      // Send the message — no client-side timeout.
      // If Electron crashes mid-send, the server-side timeoutStaleSends cron recovers it.
      const result = await adapter.send(queuedMessage);

      if (result.success) {
        await this.updateStatus(messageId, "sent");
      } else {
        console.error(`[MessageQueueProcessor] Send failed for ${messageId}: ${result.error}`);
        await this.updateStatus(messageId, "failed", result.error);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MessageQueueProcessor] Error processing ${messageId}:`, errorMessage);
      await this.updateStatus(messageId, "failed", errorMessage);
    } finally {
      if (!keepInProcessing) {
        this.processingIds.delete(messageId);
      }
    }
  }

  /**
   * Update message status in Convex.
   */
  private async updateStatus(
    messageId: Id<"messageQueue">,
    status: "sending" | "sent" | "failed",
    error?: string
  ): Promise<{ success: boolean; willRetry: boolean; reason?: string }> {
    try {
      const client = getConvexClient();
      const result = await client.mutation(api.messageQueue.updateMessageStatus, {
        messageId,
        status,
        error,
      });
      return {
        success: Boolean(result?.success),
        willRetry: Boolean(result?.willRetry),
        reason: typeof result?.reason === "string" ? result.reason : undefined,
      };
    } catch (err) {
      console.error(
        `[MessageQueueProcessor] Failed to update status:`,
        err instanceof Error ? err.message : String(err)
      );
      return { success: false, willRetry: false, reason: "request_failed" };
    }
  }

  /**
   * Check if the processor is currently running.
   */
  isRunning(): boolean {
    return this.subscription !== null && !this.stopped;
  }

  /**
   * Get the number of messages currently being processed.
   */
  getProcessingCount(): number {
    return this.processingIds.size;
  }
}

// Singleton instance
let instance: MessageQueueProcessor | null = null;

/**
 * Get the singleton MessageQueueProcessor instance.
 */
export function getMessageQueueProcessor(): MessageQueueProcessor {
  if (!instance) {
    instance = new MessageQueueProcessor();
  }
  return instance;
}
