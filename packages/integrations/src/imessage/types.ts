/**
 * iMessage types for Electron sync.
 *
 * These types represent data extracted from macOS chat.db
 * and prepared for syncing to Convex.
 */

/**
 * Handle represents a sender/recipient identifier in iMessage.
 * Corresponds to the `handle` table in chat.db.
 */
export interface Handle {
  /** ROWID from chat.db */
  id: number;
  /** Phone number or email (e.g., "+15551234567", "user@example.com") */
  identifier: string;
  /** Service type: "iMessage", "SMS" */
  service: string;
}

/**
 * Chat represents a conversation (DM or group chat) in iMessage.
 * Corresponds to the `chat` table in chat.db.
 */
export interface Chat {
  /** ROWID from chat.db */
  id: number;
  /** Chat identifier (e.g., "chat123456789" or phone number for DMs) */
  identifier: string;
  /** Display name (group name or resolved contact name) */
  displayName: string | null;
  /** Whether this is a group chat (>1 participant) */
  isGroup: boolean;
  /** Participant handles for this chat */
  participants: Handle[];
}

/**
 * Message represents a single iMessage/SMS.
 * Corresponds to the `message` table in chat.db.
 */
export interface Message {
  /** ROWID from chat.db (used as sync cursor) */
  id: number;
  /** Chat ROWID this message belongs to */
  chatId: number;
  /** Message text content (extracted from text or attributedBody) */
  text: string | null;
  /** Unix timestamp in seconds */
  timestamp: number;
  /** Whether this message was sent by the user */
  isFromMe: boolean;
  /** Whether the message has been read */
  isRead: boolean;
  /** Unix timestamp when read (null if unread) */
  readAt: number | null;
  /** Whether message has attachments */
  hasAttachments: boolean;
  /** Sender handle (null if isFromMe) */
  sender: Handle | null;
}

/**
 * ChatWithMessages bundles a chat with its messages for sync.
 * Used when syncing a full conversation history.
 */
export interface ChatWithMessages {
  chat: Chat;
  messages: Message[];
}

/**
 * SyncBatch represents a batch of data to sync from Electron to the cloud.
 * Contains all data needed for incremental sync.
 */
export interface SyncBatch {
  /** Cursor position (highest message ROWID in this batch) */
  cursor: number;
  /** New or updated chats */
  chats: Chat[];
  /** New messages since last sync */
  messages: Message[];
  /** Handles referenced by chats/messages */
  handles: Handle[];
}

/**
 * SyncResult returned from the sync API endpoint.
 */
export interface SyncResult {
  /** New cursor position to store locally */
  cursor: number;
  /** Number of messages synced */
  messagesCount: number;
  /** Number of chats synced */
  chatsCount: number;
  /** Any errors encountered (partial success possible) */
  errors: string[];
}

/**
 * Contact info resolved from macOS Contacts.app.
 * Used to enrich handles with display names.
 */
export interface ResolvedContact {
  /** Display name from Contacts.app */
  displayName: string;
  /** Company/organization if available */
  company: string | null;
  /** Phone numbers associated with contact */
  phoneNumbers: string[];
  /** Email addresses associated with contact */
  emails: string[];
}
