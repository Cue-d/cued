/**
 * LinkedIn adapter for the unified message queue.
 * Implements PlatformAdapter interface using the LinkedIn API client.
 */
import type {
  PlatformAdapter,
  QueuedMessage,
  SendResult,
} from "@prm/shared";
import { getLinkedInSyncManager } from "./sync";
import { sendMessage } from "./api/messages";
import { getSyncDebugLogger } from "../../sync/debug-logger";

/**
 * Determine if an error is retryable (transient) vs permanent.
 */
function isRetryableError(error: string): boolean {
  const lowerError = error.toLowerCase();

  // Permanent errors - don't retry
  if (
    lowerError.includes("not found") ||
    lowerError.includes("invalid") ||
    lowerError.includes("forbidden") ||
    lowerError.includes("unauthorized") ||
    lowerError.includes("401") ||
    lowerError.includes("403") ||
    lowerError.includes("unauthenticated")
  ) {
    return false;
  }

  // Transient errors - retry
  if (
    lowerError.includes("timeout") ||
    lowerError.includes("connection") ||
    lowerError.includes("network") ||
    lowerError.includes("rate limit") ||
    lowerError.includes("429") ||
    lowerError.includes("500") ||
    lowerError.includes("502") ||
    lowerError.includes("503") ||
    lowerError.includes("504")
  ) {
    return true;
  }

  // Default: assume retryable
  return true;
}

/**
 * LinkedIn adapter implementing the PlatformAdapter interface.
 * Sends messages via the LinkedIn API client from LinkedInSyncManager.
 */
export class LinkedInAdapter implements PlatformAdapter {
  readonly platform = "linkedin" as const;

  /**
   * Send a message via LinkedIn.
   * Requires a threadId (conversation URN) for routing.
   */
  async send(message: QueuedMessage): Promise<SendResult> {
    // Validate message
    if (!message.text) {
      return {
        success: false,
        error: "Message text is required",
        retryable: false,
      };
    }

    // LinkedIn requires a conversation ID (threadId)
    if (!message.threadId) {
      return {
        success: false,
        error: "LinkedIn messages require a conversation ID (threadId)",
        retryable: false,
      };
    }

    // Get the LinkedIn client from the sync manager
    const syncManager = getLinkedInSyncManager();
    const client = syncManager.client;

    if (!client) {
      return {
        success: false,
        error: "LinkedIn client not configured",
        retryable: true, // May become available later
      };
    }

    if (!client.isAuthenticated()) {
      return {
        success: false,
        error: "Not authenticated with LinkedIn",
        retryable: true, // User may re-authenticate
      };
    }

    try {
      const logger = getSyncDebugLogger();

      // Ensure we have the user entity URN (required for sending)
      await client.fetchSelf();

      // Send the message
      console.log(`[LinkedInAdapter] Sending message to threadId: ${message.threadId}`);
      logger.logCustomEvent('linkedin', 'send_message_start', { threadId: message.threadId });
      const sentMessage = await sendMessage(client, message.threadId, message.text);
      console.log(`[LinkedInAdapter] Message sent successfully, entityURN: ${sentMessage.entityURN}`);
      logger.logCustomEvent('linkedin', 'send_message_success', {
        threadId: message.threadId,
        entityURN: sentMessage.entityURN,
      });

      // Sync the sent message directly to Convex without re-fetching
      // This avoids calling getMessages() which can fail with
      // "Internal error fetching data from downstream"
      console.log(`[LinkedInAdapter] Syncing sent message directly: ${sentMessage.entityURN}`);
      logger.logCustomEvent('linkedin', 'sync_sent_message_trigger', {
        threadId: message.threadId,
        entityURN: sentMessage.entityURN,
      });
      syncManager.syncSentMessage(sentMessage).catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("[LinkedInAdapter] Sync sent message failed:", err);
        logger.logSyncError('linkedin', `sync_sent_message_catch: ${errMsg}`, {
          threadId: message.threadId,
          entityURN: sentMessage.entityURN,
        });
      });

      return {
        success: true,
        messageId: sentMessage.entityURN,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[LinkedInAdapter] Send failed:", errorMessage);
      getSyncDebugLogger().logSyncError('linkedin', `send_failed: ${errorMessage}`, { threadId: message.threadId });

      return {
        success: false,
        error: errorMessage,
        retryable: isRetryableError(errorMessage),
      };
    }
  }

  /**
   * Check if LinkedIn is authenticated and ready to send.
   */
  async isAuthenticated(): Promise<boolean> {
    const syncManager = getLinkedInSyncManager();
    const client = syncManager.client;

    if (!client) {
      return false;
    }

    return client.isAuthenticated();
  }
}
