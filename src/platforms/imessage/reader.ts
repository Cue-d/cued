import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizePhone, toE164 } from "../../core/utils/phone.js";
import { extractTextFromAttributedBody } from "./attributed-body.js";
import { normalizeChatDbHandleIdentifier } from "./handle-normalization.js";
import type {
  ImsAttachment,
  ImsChat,
  ImsHandle,
  ImsMessage,
  ImsReaction,
  ImsSyncBatch,
} from "./types.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export const DEFAULT_CHAT_DB_PATH = join(homedir(), "Library", "Messages", "chat.db");
const APPLE_EPOCH_OFFSET = 978307200;

function getMessageStatus(
  isFromMe: boolean,
  isSent: boolean,
  isDelivered: boolean,
  isRead: boolean,
  error: number,
): ImsMessage["status"] {
  if (error !== 0) return "failed";
  if (!isFromMe) return isRead ? "read" : "delivered";
  if (isRead) return "read";
  if (isDelivered) return "delivered";
  if (isSent) return "sent";
  return "sending";
}

type MessageRow = {
  rowid: number;
  guid: string;
  chat_id: number;
  item_type: number;
  sender_id: number | null;
  sender_identifier: string | null;
  sender_service: string | null;
  text: string | null;
  attributedBody: Uint8Array | null;
  unix_date: number | null;
  is_from_me: number;
  is_sent: number;
  is_delivered: number;
  is_read: number;
  unix_date_read: number | null;
  error: number;
  cache_has_attachments: number;
  associated_message_type: number;
};

type ReactionRow = {
  target_guid: string;
  associated_message_type: number;
  associated_message_emoji: string | null;
  reactor_identifier: string | null;
  is_from_me: number;
  unix_date: number | null;
};

type AttachmentRow = {
  message_id: number;
  guid: string;
  filename: string | null;
  transfer_name: string | null;
  mime_type: string | null;
  uti: string | null;
  total_bytes: number | null;
  is_sticker: number;
  hide_attachment: number;
  ck_record_id: string | null;
};

const TAPBACK_TYPE_TO_EMOJI: Record<number, string> = {
  2000: "❤️",
  2001: "👍",
  2002: "👎",
  2003: "😂",
  2004: "‼️",
  2005: "❓",
};

function isTapbackType(type: number): boolean {
  return type >= 2000 && type <= 3007;
}

function isTapbackRemovalType(type: number): boolean {
  return type >= 3000 && type <= 3007;
}

function getTapbackBaseType(type: number): number {
  return isTapbackRemovalType(type) ? type - 1000 : type;
}

function getMessageText(text: string | null, attributedBody: Uint8Array | null): string | null {
  const extracted = extractTextFromAttributedBody(
    attributedBody ? Buffer.from(attributedBody) : null,
  );
  if (extracted && extracted.trim() !== "") {
    return extracted;
  }
  return text;
}

function buildHandleCandidates(identifier: string): string[] {
  const trimmed = identifier.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (trimmed.includes("@")) {
    return [trimmed.toLowerCase()];
  }

  const candidates = new Set<string>();
  const normalized = normalizePhone(trimmed);
  const e164 = toE164(trimmed);
  candidates.add(trimmed);
  if (normalized) {
    candidates.add(normalized);
    if (!normalized.startsWith("+")) {
      candidates.add(`+${normalized}`);
    }
    if (normalized.length === 10) {
      candidates.add(`+1${normalized}`);
    }
  }
  if (e164) {
    candidates.add(e164);
  }
  return [...candidates].filter((candidate) => candidate.length > 0);
}

export class IMessageReader {
  private readonly db: import("node:sqlite").DatabaseSync;

  constructor(path = DEFAULT_CHAT_DB_PATH) {
    this.db = new DatabaseSync(path, { open: true, readOnly: true });
  }

  close(): void {
    this.db.close();
  }

  getMaxMessageRowid(): number {
    const row = this.db.prepare("SELECT MAX(ROWID) as max_rowid FROM message").get() as
      | {
          max_rowid: number | null;
        }
      | undefined;
    return row?.max_rowid ?? 0;
  }

  findDirectChatIdByHandleIdentifier(identifier: string): number | null {
    return this.findDirectChatIdByHandleCandidates(buildHandleCandidates(identifier));
  }

  findDirectChatIdByHandleCandidates(candidates: string[]): number | null {
    if (candidates.length === 0) {
      return null;
    }

    const row = this.db
      .prepare(
        `
      WITH requested_handles AS (
        SELECT LOWER(value) AS candidate
        FROM json_each(?)
      )
      SELECT c.ROWID AS chat_id
      FROM chat c
      JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
      JOIN handle h ON h.ROWID = chj.handle_id
      WHERE LOWER(h.id) IN (SELECT candidate FROM requested_handles)
        AND NOT EXISTS (
          SELECT 1
          FROM chat_handle_join other
          WHERE other.chat_id = c.ROWID
            AND other.handle_id <> h.ROWID
        )
      ORDER BY c.ROWID DESC
      LIMIT 1
    `,
      )
      .get(JSON.stringify(candidates)) as { chat_id: number | null } | undefined;

    return row?.chat_id ?? null;
  }

  buildSyncBatch(lastRowid: number, limit = 500): ImsSyncBatch {
    const rows = this.db
      .prepare(
        `
      SELECT
        m.ROWID as rowid,
        m.guid,
        cmj.chat_id,
        m.item_type,
        CASE WHEN m.is_from_me = 0 THEN m.handle_id ELSE NULL END as sender_id,
        h.id as sender_identifier,
        h.service as sender_service,
        m.text,
        m.attributedBody,
        CAST(m.date / 1000000000 AS INTEGER) + ${APPLE_EPOCH_OFFSET} as unix_date,
        m.is_from_me,
        m.is_sent,
        m.is_delivered,
        m.is_read,
        CASE
          WHEN m.date_read IS NULL OR m.date_read = 0 THEN NULL
          ELSE CAST(m.date_read / 1000000000 AS INTEGER) + ${APPLE_EPOCH_OFFSET}
        END as unix_date_read,
        m.error,
        m.cache_has_attachments,
        m.associated_message_type
      FROM message m
      INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.ROWID > ? AND m.item_type IN (0, 1, 2)
      ORDER BY m.ROWID
      LIMIT ?
    `,
      )
      .all(lastRowid, limit) as MessageRow[];

    if (rows.length === 0) {
      return { cursor: lastRowid, fetchedCount: 0, chats: [], messages: [], handles: [] };
    }

    const messages = this.transformMessages(rows);
    const attachments = this.getAttachmentsForMessageIds(messages.map((message) => message.id));
    for (const message of messages) {
      message.attachments = attachments.get(message.id) ?? [];
    }
    const cursor = rows[rows.length - 1]?.rowid ?? lastRowid;
    const reactions = this.getReactionsForGuids(messages.map((message) => message.guid));
    for (const message of messages) {
      message.reactions = reactions.get(message.guid) ?? [];
    }

    const chatIds = [...new Set(messages.map((message) => message.chatId))];
    const chats = this.getChats(chatIds);
    const handlesMap = new Map<number, ImsHandle>();
    for (const chat of chats) {
      for (const handle of chat.participants) {
        handlesMap.set(handle.id, handle);
      }
    }
    for (const message of messages) {
      if (message.sender) {
        handlesMap.set(message.sender.id, message.sender);
      }
    }

    return {
      cursor,
      fetchedCount: rows.length,
      chats,
      messages,
      handles: [...handlesMap.values()],
    };
  }

  private transformMessages(rows: MessageRow[]): ImsMessage[] {
    return rows
      .filter((row) => !isTapbackType(row.associated_message_type))
      .map((row) => {
        const isFromMe = row.is_from_me === 1;
        const isRead = row.is_read === 1;
        const sender =
          row.sender_id !== null
            ? {
                id: row.sender_id,
                identifier: normalizeChatDbHandleIdentifier(row.sender_identifier ?? ""),
                service: row.sender_service ?? "iMessage",
              }
            : null;

        return {
          id: row.rowid,
          guid: row.guid,
          chatId: row.chat_id,
          itemType: row.item_type,
          text: getMessageText(row.text, row.attributedBody),
          timestamp: row.unix_date ?? 0,
          isFromMe,
          isRead,
          readAt: row.unix_date_read,
          status: getMessageStatus(
            isFromMe,
            row.is_sent === 1,
            row.is_delivered === 1,
            isRead,
            row.error,
          ),
          errorCode: row.error,
          hasAttachments: row.cache_has_attachments === 1,
          attachments: [],
          sender,
          reactions: [],
        };
      });
  }

  private getAttachmentsForMessageIds(messageIds: number[]): Map<number, ImsAttachment[]> {
    if (messageIds.length === 0) {
      return new Map();
    }

    const rows = this.db
      .prepare(
        `
      WITH requested_messages AS (
        SELECT CAST(value AS INTEGER) AS message_id
        FROM json_each(?)
      )
      SELECT
        maj.message_id as message_id,
        a.guid,
        a.filename,
        a.transfer_name,
        a.mime_type,
        a.uti,
        a.total_bytes,
        a.is_sticker,
        a.hide_attachment,
        a.ck_record_id
      FROM message_attachment_join maj
      JOIN attachment a ON a.ROWID = maj.attachment_id
      WHERE maj.message_id IN (SELECT message_id FROM requested_messages)
      ORDER BY maj.message_id ASC, a.ROWID ASC
    `,
      )
      .all(JSON.stringify(messageIds)) as AttachmentRow[];

    const attachments = new Map<number, ImsAttachment[]>();
    for (const row of rows) {
      const messageAttachments = attachments.get(row.message_id) ?? [];
      messageAttachments.push({
        guid: row.guid,
        filename: row.filename,
        transferName: row.transfer_name,
        mimeType: row.mime_type,
        uti: row.uti,
        totalBytes: row.total_bytes,
        isSticker: row.is_sticker === 1,
        hideAttachment: row.hide_attachment === 1,
        ckRecordId: row.ck_record_id,
      });
      attachments.set(row.message_id, messageAttachments);
    }
    return attachments;
  }

  private getChats(chatIds: number[]): ImsChat[] {
    if (chatIds.length === 0) {
      return [];
    }

    const jsonChatIds = JSON.stringify(chatIds);
    const chatRows = this.db
      .prepare(
        `
      WITH requested_chats AS (
        SELECT CAST(value AS INTEGER) AS chat_id
        FROM json_each(?)
      ),
      participant_counts AS (
        SELECT chj.chat_id, COUNT(*) as cnt
        FROM chat_handle_join chj
        WHERE chj.chat_id IN (SELECT chat_id FROM requested_chats)
        GROUP BY chj.chat_id
      )
      SELECT
        c.ROWID as id,
        c.chat_identifier as identifier,
        c.display_name as name,
        COALESCE(pc.cnt, 0) > 1 as is_group
      FROM chat c
      LEFT JOIN participant_counts pc ON pc.chat_id = c.ROWID
      WHERE c.ROWID IN (SELECT chat_id FROM requested_chats)
    `,
      )
      .all(jsonChatIds) as Array<{
      id: number;
      identifier: string;
      name: string | null;
      is_group: number;
    }>;

    const participantRows = this.db
      .prepare(
        `
      SELECT
        chj.chat_id as chat_id,
        h.ROWID as id,
        h.id as identifier,
        h.service as service
      FROM chat_handle_join chj
      INNER JOIN handle h ON h.ROWID = chj.handle_id
      WHERE chj.chat_id IN (
        SELECT CAST(value AS INTEGER)
        FROM json_each(?)
      )
    `,
      )
      .all(jsonChatIds) as Array<{
      chat_id: number;
      id: number;
      identifier: string;
      service: string;
    }>;

    const participantsByChatId = new Map<number, ImsHandle[]>();
    for (const participant of participantRows) {
      const existing = participantsByChatId.get(participant.chat_id) ?? [];
      existing.push({
        id: participant.id,
        identifier: normalizeChatDbHandleIdentifier(participant.identifier),
        service: participant.service,
      });
      participantsByChatId.set(participant.chat_id, existing);
    }

    const chatsById = new Map<number, ImsChat>();
    for (const row of chatRows) {
      chatsById.set(row.id, {
        id: row.id,
        identifier: row.identifier,
        displayName: row.name ?? null,
        isGroup: row.is_group === 1,
        participants: participantsByChatId.get(row.id) ?? [],
      });
    }

    return chatIds
      .map((chatId) => chatsById.get(chatId) ?? null)
      .filter((chat): chat is ImsChat => Boolean(chat));
  }

  private getReactionsForGuids(guids: string[]): Map<string, ImsReaction[]> {
    if (guids.length === 0) return new Map();
    const jsonGuids = JSON.stringify(guids);
    const rows = this.db
      .prepare(
        `
      SELECT
        CASE
          WHEN m.associated_message_guid LIKE 'p:%/%' THEN substr(m.associated_message_guid, instr(m.associated_message_guid, '/') + 1)
          WHEN m.associated_message_guid LIKE 'bp:%' THEN substr(m.associated_message_guid, 4)
          ELSE m.associated_message_guid
        END as target_guid,
        m.associated_message_type,
        m.associated_message_emoji,
        h.id as reactor_identifier,
        m.is_from_me,
        CAST(m.date / 1000000000 AS INTEGER) + ${APPLE_EPOCH_OFFSET} as unix_date
      FROM message m
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.associated_message_type BETWEEN 2000 AND 3007
        AND (
          CASE
            WHEN m.associated_message_guid LIKE 'p:%/%' THEN substr(m.associated_message_guid, instr(m.associated_message_guid, '/') + 1)
            WHEN m.associated_message_guid LIKE 'bp:%' THEN substr(m.associated_message_guid, 4)
            ELSE m.associated_message_guid
          END
        ) IN (SELECT value FROM json_each(?))
    `,
      )
      .all(jsonGuids) as ReactionRow[];

    const result = new Map<string, Map<string, ImsReaction>>();
    for (const row of rows) {
      const baseType = getTapbackBaseType(row.associated_message_type);
      const emoji = row.associated_message_emoji ?? TAPBACK_TYPE_TO_EMOJI[baseType];
      if (!emoji) continue;

      const isFromMe = row.is_from_me === 1;
      const reactorIdentifier = normalizeChatDbHandleIdentifier(row.reactor_identifier ?? "");
      const reactorKey = `${isFromMe ? "__me__" : reactorIdentifier}:${baseType}`;
      if (!result.has(row.target_guid)) {
        result.set(row.target_guid, new Map());
      }

      if (isTapbackRemovalType(row.associated_message_type)) {
        result.get(row.target_guid)?.delete(reactorKey);
        continue;
      }

      result.get(row.target_guid)?.set(reactorKey, {
        emoji,
        reactorIdentifier,
        isFromMe,
        timestamp: row.unix_date ?? 0,
      });
    }

    return new Map(
      [...result.entries()].map(([guid, reactions]) => [guid, [...reactions.values()]]),
    );
  }
}
