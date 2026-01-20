/**
 * MessageQueueProcessor for Electron.
 * Subscribes to the Convex message queue and routes messages to platform adapters.
 *
 * Key features:
 * - Reactive WebSocket subscription to getQueuedMessages for messages ready to send
 * - Server-side scheduler triggers subscription updates when undo window expires
 * - Routes messages to appropriate adapters (iMessage, LinkedIn)
 * - Handles retries with exponential backoff
 * - Updates message status in Convex after send attempts
 */
import { api } from "@prm/convex";
import type { Id, Doc } from "@prm/convex";
import type { ActionPlatform, QueuedMessage } from "@prm/shared";
import {
  getReactiveConvexClient,
  type Unsubscribe,
} from "../convex-client.js";
import { getAdapter, SERVER_SIDE_PLATFORMS } from "../adapters/index.js";

/** Maximum concurrent sends to prevent overload */
const MAX_CONCURRENT_SENDS = 5;

/**
 * MessageQueueProcessor handles sending messages from the unified queue.
 *
 * Uses reactive WebSocket subscription to Convex for real-time updates.
 * When the undo window expires, a server-side scheduled mutation updates
 * the message, triggering the subscription to fire.
 */
export class MessageQueueProcessor {
  private subscription: Unsubscribe<{ messages: Doc<"messageQueue">[] }> | null = null;
  private processingIds = new Set<string>();
  private stopped = false;

  /**
   * Start processing the message queue.
   * Subscribes to getQueuedMessages for real-time updates via WebSocket.
   */
  start(): void {
    if (this.subscription) {
      return;
    }

    this.stopped = false;
    const client = getReactiveConvexClient();

    console.log("[MessageQueueProcessor] Starting WebSocket subscription...");

    // Subscribe to messages ready to send
    // Server-side scheduler triggers updates when undo window expires
    this.subscription = client.subscribe(
      api.messageQueue.getQueuedMessages,
      { limit: 20 },
      (result) => {
        this.handleQueueUpdate(result.messages);
      },
      (error) => {
        console.error("[MessageQueueProcessor] Subscription error:", error);
        this.handleSubscriptionError();
      }
    );
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

    try {
      // Skip server-side platforms (Gmail, Slack use Nango)
      if (SERVER_SIDE_PLATFORMS.includes(message.platform as ActionPlatform)) {
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
        // Don't mark as failed - let it retry when user authenticates
        return;
      }

      await this.updateStatus(messageId, "sending");

      // Convert to QueuedMessage format expected by adapters
      const queuedMessage: QueuedMessage = {
        id: messageId,
        platform: message.platform as ActionPlatform,
        recipientHandle: message.recipientHandle,
        text: message.text,
        threadId: message.chatIdentifier,
        groupHandles: message.isGroup ? [message.recipientHandle] : undefined,
      };

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
      this.processingIds.delete(messageId);
    }
  }

  /**
   * Update message status in Convex.
   */
  private async updateStatus(
    messageId: Id<"messageQueue">,
    status: "sending" | "sent" | "failed",
    error?: string
  ): Promise<void> {
    try {
      const client = getReactiveConvexClient();
      await client.mutation(api.messageQueue.updateMessageStatus, {
        messageId,
        status,
        error,
      });
    } catch (err) {
      console.error(
        `[MessageQueueProcessor] Failed to update status:`,
        err instanceof Error ? err.message : String(err)
      );
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
