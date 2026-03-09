import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractTextFromAttributedBody } from "./attributed-body.js";
import { normalizeChatDbHandleIdentifier } from "./handle-normalization.js";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
export const DEFAULT_CHAT_DB_PATH = join(homedir(), "Library", "Messages", "chat.db");
const APPLE_EPOCH_OFFSET = 978307200;
function getMessageStatus(isFromMe, isSent, isDelivered, isRead, error) {
    if (error !== 0)
        return "failed";
    if (!isFromMe)
        return isRead ? "read" : "delivered";
    if (isRead)
        return "read";
    if (isDelivered)
        return "delivered";
    if (isSent)
        return "sent";
    return "sending";
}
const TAPBACK_TYPE_TO_EMOJI = {
    2000: "❤️",
    2001: "👍",
    2002: "👎",
    2003: "😂",
    2004: "‼️",
    2005: "❓",
};
function isTapbackType(type) {
    return type >= 2000 && type <= 3007;
}
function isTapbackRemovalType(type) {
    return type >= 3000 && type <= 3007;
}
function getTapbackBaseType(type) {
    return isTapbackRemovalType(type) ? type - 1000 : type;
}
export class IMessageReader {
    db;
    constructor(path = DEFAULT_CHAT_DB_PATH) {
        this.db = new DatabaseSync(path, { open: true, readOnly: true });
    }
    close() {
        this.db.close();
    }
    getMaxMessageRowid() {
        const row = this.db.prepare("SELECT MAX(ROWID) as max_rowid FROM message").get();
        return row?.max_rowid ?? 0;
    }
    buildSyncBatch(lastRowid, limit = 500) {
        const rows = this.db.prepare(`
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
    `).all(lastRowid, limit);
        if (rows.length === 0) {
            return { cursor: lastRowid, chats: [], messages: [], handles: [] };
        }
        const messages = this.transformMessages(rows);
        const cursor = rows[rows.length - 1]?.rowid ?? lastRowid;
        const reactions = this.getReactionsForGuids(messages.map((message) => message.guid));
        for (const message of messages) {
            message.reactions = reactions.get(message.guid) ?? [];
        }
        const chatIds = [...new Set(messages.map((message) => message.chatId))];
        const chats = chatIds.map((chatId) => this.getChat(chatId)).filter((chat) => Boolean(chat));
        const handlesMap = new Map();
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
            chats,
            messages,
            handles: [...handlesMap.values()],
        };
    }
    transformMessages(rows) {
        return rows
            .filter((row) => !isTapbackType(row.associated_message_type))
            .map((row) => {
            const isFromMe = row.is_from_me === 1;
            const isRead = row.is_read === 1;
            const sender = row.sender_id !== null
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
                text: row.text ?? extractTextFromAttributedBody(row.attributedBody ? Buffer.from(row.attributedBody) : null),
                timestamp: row.unix_date ?? 0,
                isFromMe,
                isRead,
                readAt: row.unix_date_read,
                status: getMessageStatus(isFromMe, row.is_sent === 1, row.is_delivered === 1, isRead, row.error),
                errorCode: row.error,
                hasAttachments: row.cache_has_attachments === 1,
                sender,
                reactions: [],
            };
        });
    }
    getChat(chatId) {
        const row = this.db.prepare(`
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
    `).get(chatId, chatId);
        if (!row)
            return null;
        const participants = this.db.prepare(`
      SELECT h.ROWID as id, h.id as identifier, h.service
      FROM handle h
      INNER JOIN chat_handle_join chj ON chj.handle_id = h.ROWID
      WHERE chj.chat_id = ?
    `).all(chatId);
        return {
            id: row.id,
            identifier: row.identifier,
            displayName: row.name ?? null,
            isGroup: row.is_group === 1,
            participants: participants.map((participant) => ({
                id: participant.id,
                identifier: normalizeChatDbHandleIdentifier(participant.identifier),
                service: participant.service,
            })),
        };
    }
    getReactionsForGuids(guids) {
        if (guids.length === 0)
            return new Map();
        const jsonGuids = JSON.stringify(guids);
        const rows = this.db.prepare(`
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
    `).all(jsonGuids);
        const result = new Map();
        for (const row of rows) {
            const baseType = getTapbackBaseType(row.associated_message_type);
            const emoji = row.associated_message_emoji ?? TAPBACK_TYPE_TO_EMOJI[baseType];
            if (!emoji)
                continue;
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
        return new Map([...result.entries()].map(([guid, reactions]) => [guid, [...reactions.values()]]));
    }
}
//# sourceMappingURL=reader.js.map