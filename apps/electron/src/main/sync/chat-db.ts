/**
 * Read-only access to macOS chat.db (iMessage database).
 *
 * Port of backend/db/chat_db.py to TypeScript.
 * Uses better-sqlite3 for synchronous, high-performance SQLite access.
 */

import Database from "better-sqlite3";
import { homedir } from "os";
import { join } from "path";
import type {
  Attachment,
  Chat,
  Handle,
  Message,
  MessageStatus,
  Reaction,
  SyncBatch,
} from "./types";
import { extractTextFromAttributedBody } from "./attributed-body";

/**
 * Map iMessage tapback type codes to emoji.
 * See: https://iphonedevwiki.net/index.php/Message
 */
const TAPBACK_TYPE_TO_EMOJI: Record<number, string> = {
  2000: "❤️", // loved
  2001: "👍", // liked
  2002: "👎", // disliked
  2003: "😂", // laughed
  2004: "‼️", // emphasized
  2005: "❓", // questioned
  // Removal codes (3000-3005) subtract the tapback - handled separately
};

/**
 * Determine message status from chat.db flags.
 */
function getMessageStatus(
  isFromMe: boolean,
  isSent: boolean,
  isDelivered: boolean,
  isRead: boolean,
  error: number
): MessageStatus {
  if (error !== 0) {
    return "failed";
  }
  if (!isFromMe) {
    // Received messages: read by us or not
    return isRead ? "read" : "delivered";
  }
  // Sent messages: progression is sending → sent → delivered → read
  if (isRead) {
    return "read";
  }
  if (isDelivered) {
    return "delivered";
  }
  if (isSent) {
    return "sent";
  }
  return "sending";
}

// Apple timestamp epoch offset (seconds from 1970-01-01 to 2001-01-01)
const APPLE_EPOCH_OFFSET = 978307200;

/** Default path to macOS iMessage database */
export const DEFAULT_CHAT_DB_PATH = join(
  homedir(),
  "Library",
  "Messages",
  "chat.db"
);

/**
 * Convert Apple nanosecond timestamp to Unix seconds.
 */
function appleToUnix(appleTs: number | null): number | null {
  if (appleTs === null || appleTs === 0) {
    return null;
  }
  return Math.floor(appleTs / 1_000_000_000) + APPLE_EPOCH_OFFSET;
}

/**
 * Get message text, falling back to attributedBody extraction if text is null.
 */
function getMessageText(
  text: string | null,
  attributedBody: Buffer | null
): string | null {
  if (text) {
    return text;
  }
  if (attributedBody) {
    return extractTextFromAttributedBody(attributedBody);
  }
  return null;
}

// Row types from SQLite queries
interface MessageRow {
  rowid: number;
  guid: string;
  chat_id: number;
  sender_id: number | null;
  sender_identifier: string | null;
  sender_service: string | null;
  text: string | null;
  attributedBody: Buffer | null;
  date: number | null;
  is_from_me: number;
  is_sent: number;
  is_delivered: number;
  is_read: number;
  date_read: number | null;
  error: number;
  cache_has_attachments: number;
  // Reaction-related fields (only populated for tapback messages)
  associated_message_guid: string | null;
  associated_message_type: number;
  associated_message_emoji: string | null;
}

interface ReactionRow {
  rowid: number;
  target_guid: string;
  associated_message_type: number;
  associated_message_emoji: string | null;
  reactor_identifier: string | null;
  is_from_me: number;
  date: number | null;
}

interface AttachmentRow {
  id: number;
  message_id: number;
  filename: string | null;
  mime_type: string | null;
  uti: string | null;
  total_bytes: number;
  is_outgoing: number;
  created_date: number | null;
}

interface ChatRow {
  id: number;
  identifier: string;
  name: string | null;
  is_group: number;
}

interface HandleRow {
  id: number;
  identifier: string;
  service: string;
}

/**
 * Read-only wrapper for macOS chat.db.
 *
 * Opens the database in read-only mode to avoid conflicts with Messages.app.
 * Uses better-sqlite3's synchronous API for simplicity and performance.
 */
export class ChatDb {
  private db: Database.Database;
  private stmtGetMessagesSince: Database.Statement<[number, number]>;
  private stmtGetMessagesDesc: Database.Statement<[number, number, number]>;
  private stmtGetMaxRowid: Database.Statement<[]>;
  private stmtGetChatParticipants: Database.Statement<[number]>;
  private stmtGetChatById: Database.Statement<[number, number]>;
  private stmtGetReactionsForGuids: Database.Statement<[string]>;
  private stmtGetAttachmentsForMessages: Database.Statement<[string]>;

  /**
   * Create a new ChatDb instance.
   * @param path - Path to chat.db, defaults to ~/Library/Messages/chat.db
   */
  constructor(path: string = DEFAULT_CHAT_DB_PATH) {
    // Open read-only to avoid conflicts with Messages.app
    this.db = new Database(path, { readonly: true, fileMustExist: true });

    // Prepare commonly-used statements for performance
    // Note: LIMIT is required to avoid loading too many messages at once
    this.stmtGetMessagesSince = this.db.prepare(`
      SELECT
        m.ROWID as rowid,
        m.guid,
        cmj.chat_id,
        CASE WHEN m.is_from_me = 0 THEN m.handle_id ELSE NULL END as sender_id,
        h.id as sender_identifier,
        h.service as sender_service,
        m.text,
        m.attributedBody,
        m.date,
        m.is_from_me,
        m.is_sent,
        m.is_delivered,
        m.is_read,
        m.date_read,
        m.error,
        m.cache_has_attachments,
        m.associated_message_guid,
        m.associated_message_type,
        m.associated_message_emoji
      FROM message m
      INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.ROWID > ?
      ORDER BY m.ROWID
      LIMIT ?
    `);

    // DESC query for full sync (newest messages first)
    this.stmtGetMessagesDesc = this.db.prepare(`
      SELECT
        m.ROWID as rowid,
        m.guid,
        cmj.chat_id,
        CASE WHEN m.is_from_me = 0 THEN m.handle_id ELSE NULL END as sender_id,
        h.id as sender_identifier,
        h.service as sender_service,
        m.text,
        m.attributedBody,
        m.date,
        m.is_from_me,
        m.is_sent,
        m.is_delivered,
        m.is_read,
        m.date_read,
        m.error,
        m.cache_has_attachments,
        m.associated_message_guid,
        m.associated_message_type,
        m.associated_message_emoji
      FROM message m
      INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.ROWID <= ? AND m.ROWID > ?
      ORDER BY m.ROWID DESC
      LIMIT ?
    `);

    // Query to get reactions targeting specific message GUIDs
    // associated_message_guid format: "p:0/TARGET_GUID" or "bp:TARGET_GUID"
    // We extract the GUID part after the last '/' or ':'
    this.stmtGetReactionsForGuids = this.db.prepare(`
      SELECT
        m.ROWID as rowid,
        CASE
          WHEN m.associated_message_guid LIKE 'p:%/%' THEN substr(m.associated_message_guid, instr(m.associated_message_guid, '/') + 1)
          WHEN m.associated_message_guid LIKE 'bp:%' THEN substr(m.associated_message_guid, 4)
          ELSE m.associated_message_guid
        END as target_guid,
        m.associated_message_type,
        m.associated_message_emoji,
        h.id as reactor_identifier,
        m.is_from_me,
        m.date
      FROM message m
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.associated_message_type BETWEEN 2000 AND 2005
        AND (
          CASE
            WHEN m.associated_message_guid LIKE 'p:%/%' THEN substr(m.associated_message_guid, instr(m.associated_message_guid, '/') + 1)
            WHEN m.associated_message_guid LIKE 'bp:%' THEN substr(m.associated_message_guid, 4)
            ELSE m.associated_message_guid
          END
        ) IN (SELECT value FROM json_each(?))
    `);

    this.stmtGetMaxRowid = this.db.prepare(`
      SELECT MAX(ROWID) as max_rowid FROM message
    `);

    this.stmtGetChatParticipants = this.db.prepare(`
      SELECT h.ROWID as id, h.id as identifier, h.service
      FROM handle h
      INNER JOIN chat_handle_join chj ON chj.handle_id = h.ROWID
      WHERE chj.chat_id = ?
    `);

    this.stmtGetChatById = this.db.prepare(`
      WITH participant_counts AS (
        SELECT chat_id, COUNT(*) as cnt
        FROM chat_handle_join
        WHERE chat_id = ?
        GROUP BY chat_id
      )
      SELECT
        c.ROWID as id,
        c.chat_identifier as identifier,
        c.display_name as name,
        COALESCE(pc.cnt, 0) > 1 as is_group
      FROM chat c
      LEFT JOIN participant_counts pc ON pc.chat_id = c.ROWID
      WHERE c.ROWID = ?
    `);

    // Query to get attachments for a list of message ROWIDs
    this.stmtGetAttachmentsForMessages = this.db.prepare(`
      SELECT
        a.ROWID as id,
        maj.message_id,
        a.filename,
        a.mime_type,
        a.uti,
        a.total_bytes,
        a.is_outgoing,
        a.created_date
      FROM attachment a
      INNER JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
      WHERE maj.message_id IN (SELECT value FROM json_each(?))
    `);
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  // =========================================================================
  // SYNC SUPPORT QUERIES
  // =========================================================================

  /**
   * Get the highest message ROWID.
   * Used to initialize sync cursor on first run.
   */
  getMaxMessageRowid(): number {
    const row = this.stmtGetMaxRowid.get() as
      | { max_rowid: number | null }
      | undefined;
    return row?.max_rowid ?? 0;
  }

  /**
   * Transform raw message rows into Message objects.
   * Filters out tapback reactions (types 2000-3005) - they're attached to target messages instead.
   */
  private transformMessageRows(rows: MessageRow[]): Message[] {
    const contentMessages = rows.filter(
      (row) =>
        row.associated_message_type < 2000 || row.associated_message_type > 3005
    );

    return contentMessages.map((row) => {
      const text = getMessageText(row.text, row.attributedBody);
      const timestamp = appleToUnix(row.date) ?? 0;
      const readAt = appleToUnix(row.date_read);
      const isFromMe = row.is_from_me === 1;
      const isRead = row.is_read === 1;

      const status = getMessageStatus(
        isFromMe,
        row.is_sent === 1,
        row.is_delivered === 1,
        isRead,
        row.error
      );

      const sender: Handle | null =
        row.sender_id !== null
          ? {
              id: row.sender_id,
              identifier: row.sender_identifier ?? "",
              service: row.sender_service ?? "iMessage",
            }
          : null;

      return {
        id: row.rowid,
        guid: row.guid,
        chatId: row.chat_id,
        text,
        timestamp,
        isFromMe,
        isRead,
        readAt,
        status,
        errorCode: row.error,
        hasAttachments: row.cache_has_attachments === 1,
        attachments: [],
        sender,
        reactions: [],
      };
    });
  }

  /**
   * Get messages with ROWID > lastRowid for incremental sync.
   * Returns messages with full sender info and text extraction.
   * Filters out reaction messages (those are processed separately).
   * @param lastRowid - Fetch messages after this ROWID
   * @param limit - Maximum number of messages to fetch (default 2500)
   */
  getMessagesSince(lastRowid: number, limit: number = 2500): Message[] {
    const rows = this.stmtGetMessagesSince.all(
      lastRowid,
      limit
    ) as MessageRow[];
    return this.transformMessageRows(rows);
  }

  /**
   * Get reactions (tapbacks) for a list of message GUIDs.
   * @param guids - Array of message GUIDs to get reactions for
   * @returns Map of target GUID to array of reactions
   */
  getReactionsForGuids(guids: string[]): Map<string, Reaction[]> {
    if (guids.length === 0) {
      return new Map();
    }

    const rows = this.stmtGetReactionsForGuids.all(
      JSON.stringify(guids)
    ) as ReactionRow[];

    const reactionMap = new Map<string, Reaction[]>();

    for (const row of rows) {
      const emoji =
        row.associated_message_emoji ||
        TAPBACK_TYPE_TO_EMOJI[row.associated_message_type];
      if (!emoji) continue;

      const reaction: Reaction = {
        emoji,
        reactorIdentifier: row.reactor_identifier ?? "",
        isFromMe: row.is_from_me === 1,
        timestamp: appleToUnix(row.date) ?? 0,
      };

      if (!reactionMap.has(row.target_guid)) {
        reactionMap.set(row.target_guid, []);
      }
      reactionMap.get(row.target_guid)!.push(reaction);
    }

    return reactionMap;
  }

  /**
   * Get attachments for a list of message ROWIDs.
   * @param messageIds - Array of message ROWIDs to get attachments for
   * @returns Map of message ROWID to array of attachments
   */
  getAttachmentsForMessages(messageIds: number[]): Map<number, Attachment[]> {
    if (messageIds.length === 0) {
      return new Map();
    }

    const rows = this.stmtGetAttachmentsForMessages.all(
      JSON.stringify(messageIds)
    ) as AttachmentRow[];

    const attachmentMap = new Map<number, Attachment[]>();

    for (const row of rows) {
      // Skip attachments without a filename (can happen with deleted files)
      if (!row.filename) continue;

      // Extract just the filename from the full path
      const pathParts = row.filename.split("/");
      const filename = pathParts[pathParts.length - 1] || "attachment";

      const attachment: Attachment = {
        id: row.id,
        filename,
        path: row.filename, // Full path for file access
        mimeType: row.mime_type,
        uti: row.uti,
        size: row.total_bytes,
        isOutgoing: row.is_outgoing === 1,
        createdAt: appleToUnix(row.created_date),
      };

      if (!attachmentMap.has(row.message_id)) {
        attachmentMap.set(row.message_id, []);
      }
      attachmentMap.get(row.message_id)!.push(attachment);
    }

    return attachmentMap;
  }

  /**
   * Get a single chat by ID with participant info.
   */
  getChat(chatId: number): Chat | null {
    const row = this.stmtGetChatById.get(chatId, chatId) as ChatRow | undefined;
    if (!row) {
      return null;
    }

    const participants = this.getChatParticipants(chatId);

    return {
      id: row.id,
      identifier: row.identifier,
      displayName: row.name || row.identifier,
      isGroup: row.is_group === 1,
      participants,
    };
  }

  /**
   * Get participants for a chat.
   */
  getChatParticipants(chatId: number): Handle[] {
    const rows = this.stmtGetChatParticipants.all(chatId) as HandleRow[];

    return rows.map((row) => ({
      id: row.id,
      identifier: row.identifier,
      service: row.service,
    }));
  }

  /**
   * Hydrate messages with reactions, attachments, chats, and handles.
   * Shared by both ASC and DESC sync batch builders.
   */
  private hydrateMessages(messages: Message[]): {
    chats: Chat[];
    handles: Handle[];
  } {
    // Fetch reactions for all messages in the batch
    const guids = messages.map((m) => m.guid);
    const reactionMap = this.getReactionsForGuids(guids);

    // Attach reactions to their target messages
    for (const msg of messages) {
      const reactions = reactionMap.get(msg.guid);
      if (reactions) {
        msg.reactions = reactions;
      }
    }

    // Fetch attachments for messages that have them
    const messagesWithAttachments = messages.filter((m) => m.hasAttachments);
    if (messagesWithAttachments.length > 0) {
      const messageIds = messagesWithAttachments.map((m) => m.id);
      const attachmentMap = this.getAttachmentsForMessages(messageIds);

      // Attach attachments to their messages
      for (const msg of messagesWithAttachments) {
        const attachments = attachmentMap.get(msg.id);
        if (attachments) {
          msg.attachments = attachments;
        }
      }
    }

    // Fetch chats for all unique chat IDs in messages
    const chatIds = [...new Set(messages.map((m) => m.chatId))];
    const chats = chatIds
      .map((id) => this.getChat(id))
      .filter((c): c is Chat => c !== null);

    // Collect handles from chat participants and message senders
    const handlesMap = new Map<number, Handle>();
    for (const chat of chats) {
      for (const p of chat.participants) {
        handlesMap.set(p.id, p);
      }
    }
    for (const msg of messages) {
      if (msg.sender) {
        handlesMap.set(msg.sender.id, msg.sender);
      }
    }

    return { chats, handles: [...handlesMap.values()] };
  }

  /**
   * Build a sync batch from new messages since lastRowid.
   * Groups messages by chat, includes all referenced handles, attaches reactions and attachments.
   * @param lastRowid - Fetch messages after this ROWID
   * @param limit - Maximum number of messages to fetch (default 2500)
   */
  buildSyncBatch(lastRowid: number, limit: number = 2500): SyncBatch {
    const messages = this.getMessagesSince(lastRowid, limit);

    if (messages.length === 0) {
      return { cursor: lastRowid, chats: [], messages: [], handles: [] };
    }

    const { chats, handles } = this.hydrateMessages(messages);

    // Messages are ordered by ROWID ASC, so the last one has the highest id
    const cursor = messages[messages.length - 1].id;

    return { cursor, chats, messages, handles };
  }

  /**
   * Get messages with ROWID <= maxRowid and ROWID > minRowid in DESC order for full sync.
   * Returns messages from newest to oldest.
   * @param maxRowid - Maximum ROWID to include (upper bound, inclusive)
   * @param minRowid - Minimum ROWID to exclude (lower bound, exclusive)
   * @param limit - Maximum number of messages to fetch (default 2500)
   */
  getMessagesDescending(
    maxRowid: number,
    minRowid: number,
    limit: number = 2500
  ): Message[] {
    const rows = this.stmtGetMessagesDesc.all(
      maxRowid,
      minRowid,
      limit
    ) as MessageRow[];
    return this.transformMessageRows(rows);
  }

  /**
   * Build a sync batch from messages in DESC order (newest first) for full sync.
   * @param maxRowid - Maximum ROWID to include (upper bound, inclusive)
   * @param minRowid - Minimum ROWID to exclude (lower bound, exclusive), defaults to 0
   * @param limit - Maximum number of messages to fetch (default 2500)
   * @returns SyncBatch with cursor set to (lowest ROWID in batch - 1) for DESC iteration
   */
  buildSyncBatchDescending(
    maxRowid: number,
    minRowid: number = 0,
    limit: number = 2500
  ): SyncBatch {
    const messages = this.getMessagesDescending(maxRowid, minRowid, limit);

    if (messages.length === 0) {
      return { cursor: minRowid, chats: [], messages: [], handles: [] };
    }

    const { chats, handles } = this.hydrateMessages(messages);

    // For DESC order: cursor is (lowest ROWID in batch - 1) to mark progress going backwards
    // Messages are sorted DESC, so last element has lowest ROWID
    const cursor = messages[messages.length - 1].id - 1;

    return { cursor, chats, messages, handles };
  }
}
