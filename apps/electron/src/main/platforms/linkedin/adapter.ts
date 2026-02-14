/**
 * LinkedIn adapter for the unified message queue.
 * Implements PlatformAdapter interface using the LinkedIn API client.
 */
import type {
  PlatformAdapter,
  QueuedMessage,
  SendResult,
} from "@cued/shared";
import {
  requireMessageText,
  requireThreadId,
} from "../../adapters/validation";
import {
  getErrorMessage,
  isRetryableError,
} from "../../sync/error-utils";
import { getSyncDebugLogger } from "../../sync/debug-logger";
import { sendMessage } from "./api/messages";
import { getLinkedInSyncManager } from "./sync";

const LINKEDIN_PERMANENT_ERROR_PATTERNS = [
  "not found",
  "invalid",
  "forbidden",
  "unauthorized",
  "401",
  "403",
  "unauthenticated",
] as const;

const LINKEDIN_TRANSIENT_ERROR_PATTERNS = [
  "timeout",
  "connection",
  "network",
  "rate limit",
  "429",
  "500",
  "502",
  "503",
  "504",
] as const;

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
    const textValidation = requireMessageText(message);
    if (!textValidation.ok) return textValidation.result;

    const threadIdValidation = requireThreadId(message, "LinkedIn");
    if (!threadIdValidation.ok) return threadIdValidation.result;

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
      const threadId = threadIdValidation.value;
      console.log(`[LinkedInAdapter] Sending message to threadId: ${threadId}`);
      logger.logCustomEvent("linkedin", "send_message_start", { threadId });
      const sentMessage = await sendMessage(client, threadId, textValidation.value);
      console.log(
        `[LinkedInAdapter] Message sent successfully, entityURN: ${sentMessage.entityURN}`,
      );
      logger.logCustomEvent("linkedin", "send_message_success", {
        threadId,
        entityURN: sentMessage.entityURN,
      });

      // Sync the sent message directly to Convex without re-fetching
      // This avoids calling getMessages() which can fail with
      // "Internal error fetching data from downstream"
      console.log(
        `[LinkedInAdapter] Syncing sent message directly: ${sentMessage.entityURN}`,
      );
      logger.logCustomEvent("linkedin", "sync_sent_message_trigger", {
        threadId,
        entityURN: sentMessage.entityURN,
      });
      syncManager.syncSentMessage(sentMessage).catch((err) => {
        const errMsg = getErrorMessage(err);
        console.error("[LinkedInAdapter] Sync sent message failed:", err);
        logger.logSyncError("linkedin", `sync_sent_message_catch: ${errMsg}`, {
          threadId,
          entityURN: sentMessage.entityURN,
        });
      });

      return {
        success: true,
        messageId: sentMessage.entityURN,
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error("[LinkedInAdapter] Send failed:", errorMessage);
      getSyncDebugLogger().logSyncError("linkedin", `send_failed: ${errorMessage}`, {
        threadId: threadIdValidation.value,
      });

      return {
        success: false,
        error: errorMessage,
        retryable: isRetryableError(errorMessage, {
          permanentPatterns: LINKEDIN_PERMANENT_ERROR_PATTERNS,
          transientPatterns: LINKEDIN_TRANSIENT_ERROR_PATTERNS,
        }),
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
