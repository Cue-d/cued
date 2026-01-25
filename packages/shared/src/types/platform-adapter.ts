/**
 * Platform adapter types for the unified message queue.
 * Adapters implement platform-specific sending logic (iMessage, LinkedIn, etc.)
 */

import type { ActionPlatform } from "../constants/platform.js";

/**
 * Result of a message send attempt.
 */
export interface SendResult {
  /** Whether the send was successful */
  success: boolean;
  /** Error message if send failed */
  error?: string;
  /** Platform-specific message ID if available */
  messageId?: string;
  /** Whether this error is retryable */
  retryable?: boolean;
}

/**
 * Message to be sent via an adapter.
 */
export interface QueuedMessage {
  /** Unique message queue ID */
  id: string;
  /** Target platform */
  platform: ActionPlatform;
  /** Recipient handle (email, phone, profile URL, etc.) */
  recipientHandle: string;
  /** Optional recipient display name */
  recipientName?: string;
  /** Message text content */
  text: string;
  /** For group messages: list of handles */
  groupHandles?: string[];
  /** Optional thread/conversation ID for replies */
  threadId?: string;
  /** For multi-workspace platforms (Slack teamId, Gmail email address) */
  workspaceId?: string;
}

/**
 * Interface for platform-specific message adapters.
 * Each platform (iMessage, LinkedIn, etc.) implements this interface.
 *
 * @example
 * ```ts
 * class IMessageAdapter implements PlatformAdapter {
 *   platform = "imessage" as const;
 *
 *   async send(message: QueuedMessage): Promise<SendResult> {
 *     // AppleScript to send via Messages.app
 *   }
 *
 *   async isAuthenticated(): Promise<boolean> {
 *     // Check if iMessage is configured
 *   }
 * }
 * ```
 */
export interface PlatformAdapter {
  /** The platform this adapter handles */
  readonly platform: ActionPlatform;

  /**
   * Send a message via this platform.
   * @param message - The message to send
   * @returns Result indicating success/failure
   */
  send(message: QueuedMessage): Promise<SendResult>;

  /**
   * Check if the user is authenticated with this platform.
   * @returns true if authenticated and ready to send
   */
  isAuthenticated(): Promise<boolean>;
}
