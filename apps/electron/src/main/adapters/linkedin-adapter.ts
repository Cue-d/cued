/**
 * LinkedIn adapter for the unified message queue.
 * Implements PlatformAdapter interface using the LinkedIn API client.
 */
import type {
  PlatformAdapter,
  QueuedMessage,
  SendResult,
} from "@prm/shared";
import { getLinkedInSyncManager } from "../sync/linkedin-sync.js";
import { sendMessage } from "../linkedin-api/messages.js";

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
      // Ensure we have the user entity URN (required for sending)
      await client.fetchSelf();

      // Send the message
      const sentMessage = await sendMessage(client, message.threadId, message.text);

      return {
        success: true,
        messageId: sentMessage.entityURN,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[LinkedInAdapter] Send failed:", errorMessage);

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
