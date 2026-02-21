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
 * Message delivery status.
 */
export type MessageStatus = "sending" | "sent" | "delivered" | "read" | "failed";

/**
 * Reaction (tapback) on a message.
 */
export interface Reaction {
  /** Emoji representing the reaction */
  emoji: string;
  /** Handle identifier of who reacted */
  reactorIdentifier: string;
  /** Whether the reaction is from the current user */
  isFromMe: boolean;
  /** Unix timestamp when reaction was added */
  timestamp: number;
}

/**
 * Message represents a single iMessage/SMS.
 * Corresponds to the `message` table in chat.db.
 */
export interface Message {
  /** ROWID from chat.db (used as sync cursor) */
  id: number;
  /** Unique message identifier (GUID from chat.db) */
  guid: string;
  /** Chat ROWID this message belongs to */
  chatId: number;
  /** message.item_type from chat.db (0=normal, 1=member change, 2=name change) */
  itemType?: number;
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
  /** Message delivery status */
  status: MessageStatus;
  /** Error code if status is "failed" (0 = no error) */
  errorCode: number;
  /** Whether message has attachments */
  hasAttachments: boolean;
  /** Sender handle (null if isFromMe) */
  sender: Handle | null;
  /** Reactions (tapbacks) on this message */
  reactions: Reaction[];
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
  /** Local avatar URL served via the app-managed contact avatar protocol */
  avatarUrl?: string;
  /** Phone numbers associated with contact */
  phoneNumbers: string[];
  /** Email addresses associated with contact */
  emails: string[];
}
