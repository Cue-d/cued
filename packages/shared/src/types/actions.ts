/**
 * Shared types for action queue components.
 * These types are used across mobile, web, and UI packages.
 */

/**
 * Message data for display in the action queue.
 * Represents a single message in a conversation thread.
 */
export interface DisplayMessage {
  /** Unique message identifier */
  _id: string;
  /** Message content text */
  content: string | null;
  /** Timestamp when the message was sent (Unix ms) */
  sentAt: number;
  /** Whether this message was sent by the current user */
  isFromMe: boolean;
  /** Display name of the sender */
  senderName: string | null;
  /** Delivery status (sent, delivered, read, etc.) */
  status?: string | null;
  /** Reaction emojis on this message */
  reactions?: string[] | null;
}

/**
 * Form data for contact action cards.
 * Used when creating or updating contact information.
 */
export interface ContactFormData {
  /** Contact's full name */
  name: string;
  /** Company or organization */
  company: string;
  /** Comma-separated tags */
  tags: string;
  /** Free-form notes */
  notes: string;
  /** ID of an existing contact to link/merge with */
  linkedContactId?: string | null;
}

/**
 * Action item enriched with related contact/conversation data.
 * Used in action queue pages on web and mobile.
 */
export interface EnrichedAction {
  /** Action ID */
  _id: string;
  /** Action type (respond, follow_up, etc.) */
  type: string;
  /** Current status */
  status: string;
  /** Priority level (higher = more important) */
  priority: number;
  /** User-facing reason for the action */
  reason: string | null;
  /** LLM-generated reasoning */
  llmReason: string | null;
  /** When the action was created (Unix ms) */
  createdAt: number;
  /** Snooze until timestamp (Unix ms) */
  snoozedUntil: number | null;
  /** When the action was completed (Unix ms) */
  completedAt: number | null;
  /** When the action was discarded (Unix ms) */
  discardedAt: number | null;
  /** Related conversation ID */
  conversationId: string | null;
  /** Primary contact ID */
  contactId: string | null;
  /** Primary contact display name */
  contactName: string | null;
  /** Secondary contact ID (for merge actions) */
  secondaryContactId: string | null;
  /** Secondary contact display name */
  secondaryContactName: string | null;
  /** Merge confidence score */
  mergeConfidence?: number | null;
  /** Source of merge suggestion */
  mergeSource?: string | null;
  /** Reasoning for merge */
  mergeReasoning?: string | null;
  /** Merge suggestion ID */
  mergeSuggestionId?: string | null;
  /** Platform (imessage, gmail, etc.) */
  platform: string | null;
}
