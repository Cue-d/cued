/**
 * Shared types for action queue components.
 * These types are used across mobile, web, and UI packages.
 */

/**
 * Attachment metadata for a message.
 */
export interface MessageAttachment {
  /** Original filename, if available */
  filename: string | null;
  /** MIME type of the attachment */
  mimeType: string | null;
  /** URL to access the attachment */
  url: string | null;
  /** URL to a thumbnail preview, if available */
  thumbnailUrl?: string | null;
}

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
  /** File attachments */
  attachments?: MessageAttachment[] | null;
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
