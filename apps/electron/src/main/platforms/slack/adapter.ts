/**
 * Slack adapter for the unified message queue.
 * Implements PlatformAdapter interface using the native SlackClient.
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
import { isAuthError } from "../../auth/auth-utils";
import {
  getErrorMessage,
  isRetryableError,
} from "../../sync/error-utils";
import { SlackRateLimitError } from "./api";
import { getSlackSyncManager, getAllSlackSyncManagers } from "./sync";

/** Permanent Slack errors that should not be retried */
const PERMANENT_ERRORS = [
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "msg_too_long",
  "no_text",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "not_authed",
] as const;

/** Transient errors that should be retried */
const TRANSIENT_ERRORS = [
  "timeout",
  "connection",
  "network",
  "rate",
  "ratelimited",
  "500",
  "502",
  "503",
  "504",
] as const;

/**
 * Determine if an error is retryable (transient) vs permanent.
 */
function isRetryableSlackError(error: unknown): boolean {
  if (error instanceof SlackRateLimitError) return true;
  if (isAuthError(error)) return false;

  return isRetryableError(error, {
    permanentPatterns: PERMANENT_ERRORS,
    transientPatterns: TRANSIENT_ERRORS,
  });
}

/**
 * Slack adapter implementing the PlatformAdapter interface.
 * Sends messages via the native SlackClient from SlackSyncManager.
 */
export class SlackAdapter implements PlatformAdapter {
  readonly platform = "slack" as const;

  /**
   * Send a message via Slack.
   * Requires a threadId (channel ID) for routing.
   * Supports thread replies via threadTs in the threadId (format: "channelId:threadTs").
   * For multi-workspace support, workspaceId (teamId) is required.
   */
  async send(message: QueuedMessage): Promise<SendResult> {
    const textValidation = requireMessageText(message);
    if (!textValidation.ok) return textValidation.result;

    const threadIdValidation = requireThreadId(message, "Slack");
    if (!threadIdValidation.ok) return threadIdValidation.result;

    // Get the Slack client from the sync manager
    // Use workspaceId (teamId) if provided for multi-workspace support
    let syncManager;
    try {
      syncManager = getSlackSyncManager({ teamId: message.workspaceId });
    } catch (error) {
      // If multiple workspaces exist but no teamId provided, return clear error
      const errorMessage = getErrorMessage(error);
      return {
        success: false,
        error: errorMessage,
        retryable: false, // Can't retry without workspace context
      };
    }
    const client = syncManager.getClient();

    if (!client) {
      return {
        success: false,
        error: "Slack client not configured",
        retryable: true, // May become available later
      };
    }

    try {
      // Parse threadId - may contain thread timestamp for replies
      // Format: "channelId" or "channelId:threadTs"
      let channelId = threadIdValidation.value;
      let threadTs: string | undefined;

      if (threadIdValidation.value.includes(":")) {
        const parts = threadIdValidation.value.split(":");
        channelId = parts[0];
        threadTs = parts[1];
      }

      // Send the message
      const response = await client.postMessage(channelId, textValidation.value, {
        threadTs,
      });

      // Trigger immediate sync to fetch our sent message and any replies
      // This runs async and doesn't block the send response
      syncManager.triggerSync().catch((err) => {
        console.warn("[SlackAdapter] Post-send sync failed:", err);
      });

      return {
        success: true,
        messageId: response.ts, // Slack message timestamp acts as ID
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error("[SlackAdapter] Send failed:", errorMessage);

      return {
        success: false,
        error: errorMessage,
        retryable: isRetryableSlackError(error),
      };
    }
  }

  /**
   * Check if Slack is authenticated and ready to send.
   * Returns true if at least one Slack workspace is authenticated.
   */
  async isAuthenticated(): Promise<boolean> {
    const managers = getAllSlackSyncManagers();
    return managers.some((m) => m.isAuthenticated());
  }
}
