/**
 * Shared platform adapter interfaces for message queue.
 * Implemented by platform-specific adapters (iMessage, Slack, Gmail, etc.).
 */

import type { ActionPlatform } from "../constants/platform";

export interface SendResult {
  success: boolean;
  error?: string;
  platformMessageId?: string;
}

export interface QueuedMessage {
  id: string;
  actionId: string;
  platform: ActionPlatform;
  recipient: string;
  content: string;
  scheduledAt: number;
  retryCount: number;
  maxRetries: number;
}

export interface PlatformAdapter {
  /** Send a message through the platform */
  sendMessage(message: QueuedMessage): Promise<SendResult>;

  /** Check if platform/account is available and authenticated */
  isAvailable(): Promise<boolean>;

  /** Optional: Validate recipient format for this platform */
  validateRecipient?(recipient: string): boolean;
}
