/**
 * Read-only access to macOS chat.db (iMessage database).
 *
 * Port of backend/db/chat_db.py to TypeScript.
 * Uses better-sqlite3 for synchronous, high-performance SQLite access.
 */

import Database from "better-sqlite3";
import { homedir } from "os";
import { join } from "path";
import type { Chat, Handle, Message, SyncBatch } from "./types";
import { extractTextFromAttributedBody } from "./attributed-body";

// Apple timestamp epoch offset (seconds from 1970-01-01 to 2001-01-01)
const APPLE_EPOCH_OFFSET = 978307200;

/** Default path to macOS iMessage database */
export const DEFAULT_CHAT_DB_PATH = join(homedir(), "Library", "Messages", "chat.db");

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
function getMessageText(text: string | null, attributedBody: Buffer | null): string | null {
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
  chat_id: number;
  sender_id: number | null;
  sender_identifier: string | null;
  sender_service: string | null;
  text: string | null;
  attributedBody: Buffer | null;
  date: number | null;
  is_from_me: number;
  is_read: number;
  date_read: number | null;
  cache_has_attachments: number;
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
  private stmtGetMessagesSince: Database.Statement<[number]>;
  private stmtGetMaxRowid: Database.Statement<[]>;
  private stmtGetChatParticipants: Database.Statement<[number]>;
  private stmtGetChatById: Database.Statement<[number, number]>;

  /**
   * Create a new ChatDb instance.
   * @param path - Path to chat.db, defaults to ~/Library/Messages/chat.db
   */
  constructor(path: string = DEFAULT_CHAT_DB_PATH) {
    // Open read-only to avoid conflicts with Messages.app
    this.db = new Database(path, { readonly: true, fileMustExist: true });

    // Prepare commonly-used statements for performance
    this.stmtGetMessagesSince = this.db.prepare(`
      SELECT
        m.ROWID as rowid,
        cmj.chat_id,
        CASE WHEN m.is_from_me = 0 THEN m.handle_id ELSE NULL END as sender_id,
        h.id as sender_identifier,
        h.service as sender_service,
        m.text,
        m.attributedBody,
        m.date,
        m.is_from_me,
        m.is_read,
        m.date_read,
        m.cache_has_attachments
      FROM message m
      INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.ROWID > ?
      ORDER BY m.ROWID
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
    const row = this.stmtGetMaxRowid.get() as { max_rowid: number | null } | undefined;
    return row?.max_rowid ?? 0;
  }

  /**
   * Get all messages with ROWID > lastRowid for incremental sync.
   * Returns messages with full sender info and text extraction.
   */
  getMessagesSince(lastRowid: number): Message[] {
    const rows = this.stmtGetMessagesSince.all(lastRowid) as MessageRow[];

    return rows.map((row) => {
      const text = getMessageText(row.text, row.attributedBody);
      const timestamp = appleToUnix(row.date) ?? 0;
      const readAt = appleToUnix(row.date_read);

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
        chatId: row.chat_id,
        text,
        timestamp,
        isFromMe: row.is_from_me === 1,
        isRead: row.is_read === 1,
        readAt,
        hasAttachments: row.cache_has_attachments === 1,
        sender,
      };
    });
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
   * Build a sync batch from new messages since lastRowid.
   * Groups messages by chat and includes all referenced handles.
   */
  buildSyncBatch(lastRowid: number): SyncBatch {
    const messages = this.getMessagesSince(lastRowid);

    if (messages.length === 0) {
      return { cursor: lastRowid, chats: [], messages: [], handles: [] };
    }

    // Fetch chats for all unique chat IDs in messages
    const chatIds = [...new Set(messages.map((m) => m.chatId))];
    const chats = chatIds.map((id) => this.getChat(id)).filter((c): c is Chat => c !== null);

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

    return {
      cursor: Math.max(...messages.map((m) => m.id)),
      chats,
      messages,
      handles: [...handlesMap.values()],
    };
  }
}
