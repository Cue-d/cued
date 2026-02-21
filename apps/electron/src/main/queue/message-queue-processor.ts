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

const LOG_PREFIX = "[MessageQueueProcessor]";

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

function summarizeMessage(message: Doc<"messageQueue">) {
  return {
    messageId: message._id,
    platform: message.platform,
    status: message.status,
    attempts: message.attempts,
    conversationId: message.conversationId ?? null,
    scheduledInMs: message.scheduledFor - Date.now(),
    ageMs: Date.now() - message.createdAt,
    processingDeviceId: message.processingDeviceId ?? null,
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
      console.log(`${LOG_PREFIX} Start requested but subscription already active`);
      return;
    }

    this.stopped = false;
    const client = getConvexClient();

    console.log(`${LOG_PREFIX} Starting WebSocket subscription`, {
      deviceId: this.deviceId,
      maxConcurrentSends: MAX_CONCURRENT_SENDS,
      fallbackPollIntervalMs: FALLBACK_POLL_INTERVAL_MS,
    });

    // Subscribe to messages ready to send
    this.subscription = client.subscribe(
      api.messageQueue.getQueuedMessages,
      { limit: 20 },
      (result) => {
        if (result.messages.length > 0) {
          const sampleMessageIds = result.messages
            .slice(0, 5)
            .map((m) => m._id);
          console.log(`${LOG_PREFIX} Subscription update`, {
            readyCount: result.messages.length,
            sampleMessageIds,
          });
        }
        this.handleQueueUpdate(result.messages);
      },
      (error) => {
        console.error(`${LOG_PREFIX} Subscription error`, toErrorMessage(error));
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
      console.log(`${LOG_PREFIX} Fallback polling enabled`, {
        intervalMs: FALLBACK_POLL_INTERVAL_MS,
      });
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
        console.log(`${LOG_PREFIX} Poll result`, {
          source,
          readyCount: result.messages.length,
          sampleMessageIds: result.messages.slice(0, 5).map((m) => m._id),
        });
      }
      if (result.messages.length > 0) {
        await this.handleQueueUpdate(result.messages);
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} Poll failed`, {
        source,
        error: toErrorMessage(error),
      });
    }
  }

  /**
   * Stop processing the message queue.
   */
  stop(): void {
    this.stopped = true;
    console.log(`${LOG_PREFIX} Stopping queue processor`, {
      inFlightCount: this.processingIds.size,
      subscriptionActive: this.subscription !== null,
      fallbackPollActive: this.fallbackPollInterval !== null,
    });

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
        console.log(`${LOG_PREFIX} Reconnecting after subscription error`);
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
    const skippedAlreadyProcessing = messages.length - newMessages.length;
    if (newMessages.length === 0) {
      console.log(`${LOG_PREFIX} Queue update skipped`, {
        readyCount: messages.length,
        skippedAlreadyProcessing,
        inFlightCount: this.processingIds.size,
      });
      return;
    }

    // Process messages with concurrency limit
    const batch = newMessages.slice(0, MAX_CONCURRENT_SENDS);
    console.log(`${LOG_PREFIX} Dispatching queue batch`, {
      readyCount: messages.length,
      newCount: newMessages.length,
      skippedAlreadyProcessing,
      batchCount: batch.length,
      backlogCount: Math.max(0, newMessages.length - batch.length),
      inFlightCount: this.processingIds.size,
      batchMessageIds: batch.map((m) => m._id),
    });
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
    const processStartedAt = Date.now();
    console.log(`${LOG_PREFIX} Processing message`, summarizeMessage(message));

    let keepInProcessing = false;
    try {
      // Skip server-side platforms
      if (SERVER_SIDE_PLATFORMS.includes(message.platform as ActionPlatform)) {
        console.log(`${LOG_PREFIX} Skipping server-side managed platform`, {
          messageId,
          platform: message.platform,
        });
        return;
      }

      // Claim the message (single-sender lock for multi-device)
      const client = getConvexClient();
      const claimResult = await client.mutation(api.messageQueue.claimMessage, {
        messageId,
        deviceId: this.deviceId,
      });
      if (!claimResult.success) {
        console.log(`${LOG_PREFIX} Claim failed`, {
          messageId,
          reason: claimResult.reason,
          inFlightCount: this.processingIds.size,
        });
        return;
      }
      console.log(`${LOG_PREFIX} Claim acquired`, {
        messageId,
        deviceId: this.deviceId,
      });

      // Get the adapter for this platform
      const adapter = getAdapter(message.platform as ActionPlatform);
      if (!adapter) {
        console.error(`${LOG_PREFIX} No adapter for platform`, {
          messageId,
          platform: message.platform,
        });
        await this.updateStatus(messageId, "failed", `No adapter for platform: ${message.platform}`);
        return;
      }

      // Check if adapter is authenticated
      const isAuth = await adapter.isAuthenticated();
      if (!isAuth) {
        const retryCount = this.authRetryCount.get(messageId) ?? 0;
        if (retryCount < MAX_AUTH_RETRIES) {
          this.authRetryCount.set(messageId, retryCount + 1);
          console.log(`${LOG_PREFIX} Adapter unauthenticated, scheduling retry`, {
            messageId,
            platform: message.platform,
            retryAttempt: retryCount + 1,
            maxRetries: MAX_AUTH_RETRIES,
            retryDelayMs: AUTH_RETRY_DELAY_MS,
          });
          // Keep in processingIds so subscription updates don't re-enter
          // before the delayed retry fires. The setTimeout handles cleanup.
          keepInProcessing = true;
          setTimeout(() => {
            this.processingIds.delete(messageId);
            void this.pollOnce("fallback");
          }, AUTH_RETRY_DELAY_MS);
          return;
        }
        console.warn(`${LOG_PREFIX} Adapter still unauthenticated after retries`, {
          messageId,
          platform: message.platform,
          retries: MAX_AUTH_RETRIES,
        });
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
          console.log(`${LOG_PREFIX} Sending transition rejected due to conversation lock`, {
            messageId,
            reason: sendingTransition.reason,
          });
        } else {
          console.log(`${LOG_PREFIX} Sending transition rejected`, {
            messageId,
            reason: sendingTransition.reason ?? "unknown",
          });
        }
        return;
      }
      console.log(`${LOG_PREFIX} Message transitioned to sending`, {
        messageId,
        platform: message.platform,
      });

      // Convert to QueuedMessage format expected by adapters
      const queuedMessage: QueuedMessage = {
        id: messageId,
        platform: message.platform as ActionPlatform,
        recipientHandle: message.recipientHandle,
        text: message.text,
        attachments: message.attachments,
        threadId: message.chatIdentifier,
        groupHandles: message.isGroup ? [message.recipientHandle] : undefined,
        workspaceId: message.workspaceId,
      };
      console.log(`${LOG_PREFIX} Dispatching adapter send`, {
        messageId,
        platform: queuedMessage.platform,
        hasThreadId: Boolean(queuedMessage.threadId),
        isGroup: Boolean(queuedMessage.groupHandles?.length),
        textLength: queuedMessage.text.length,
        attachmentsCount: queuedMessage.attachments?.length ?? 0,
      });

      // Send the message — no client-side timeout.
      // If Electron crashes mid-send, the server-side timeoutStaleSends cron recovers it.
      const sendStartMs = Date.now();
      const result = await adapter.send(queuedMessage);
      const sendDurationMs = Date.now() - sendStartMs;

      if (result.success) {
        console.log(`${LOG_PREFIX} Adapter send succeeded`, {
          messageId,
          platform: message.platform,
          adapterMessageId: result.messageId ?? null,
          durationMs: sendDurationMs,
        });
        await this.updateStatus(messageId, "sent");
      } else {
        console.error(`${LOG_PREFIX} Adapter send failed`, {
          messageId,
          platform: message.platform,
          durationMs: sendDurationMs,
          error: result.error ?? "unknown",
          retryable: result.retryable ?? null,
        });
        await this.updateStatus(messageId, "failed", result.error);
      }
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      console.error(`${LOG_PREFIX} Error processing message`, {
        messageId,
        error: errorMessage,
      });
      await this.updateStatus(messageId, "failed", errorMessage);
    } finally {
      if (!keepInProcessing) {
        this.processingIds.delete(messageId);
      }
      console.log(`${LOG_PREFIX} Finished processing message`, {
        messageId,
        durationMs: Date.now() - processStartedAt,
        keptInProcessing: keepInProcessing,
        inFlightCount: this.processingIds.size,
      });
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
      console.log(`${LOG_PREFIX} Updating message status`, {
        messageId,
        status,
        hasError: Boolean(error),
      });
      const result = await client.mutation(api.messageQueue.updateMessageStatus, {
        messageId,
        status,
        error,
      });
      const mappedResult = {
        success: Boolean(result?.success),
        willRetry: Boolean(result?.willRetry),
        reason: typeof result?.reason === "string" ? result.reason : undefined,
      };
      console.log(`${LOG_PREFIX} Status update result`, {
        messageId,
        status,
        ...mappedResult,
      });
      return mappedResult;
    } catch (err) {
      console.error(
        `${LOG_PREFIX} Failed to update status`,
        {
          messageId,
          status,
          error: err instanceof Error ? err.message : String(err),
        }
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
