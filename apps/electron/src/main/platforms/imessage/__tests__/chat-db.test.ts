import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type BetterSqlite3 from "better-sqlite3";

// better-sqlite3 is built for Electron's Node version, not system Node.
// Skip these tests when the native module can't be loaded.
let Database: typeof BetterSqlite3 | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("better-sqlite3");
  // Actually try to instantiate to trigger native module load
  const testDb = new mod(":memory:");
  testDb.close();
  Database = mod;
} catch {
  // Module not available for current Node version
}

// Apple timestamp epoch offset (seconds from 1970-01-01 to 2001-01-01)
const APPLE_EPOCH_OFFSET = 978307200;

function unixToApple(unixTs: number): number {
  return (unixTs - APPLE_EPOCH_OFFSET) * 1_000_000_000;
}

// SQL queries matching ChatDb implementation
const SQL_GET_MESSAGES_SINCE = `
  SELECT
    m.ROWID as rowid,
    m.guid,
    cmj.chat_id,
    m.item_type,
    CASE WHEN m.is_from_me = 0 THEN m.handle_id ELSE NULL END as sender_id,
    h.id as sender_identifier,
    h.service as sender_service,
    m.text,
    m.date,
    m.is_from_me,
    m.is_sent,
    m.is_delivered,
    m.is_read,
    m.error,
    m.associated_message_guid,
    m.associated_message_type,
    m.associated_message_emoji
  FROM message m
  INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE m.ROWID > ? AND m.item_type IN (0, 1, 2)
  ORDER BY m.ROWID
`;

const SQL_GET_CHAT_PARTICIPANTS = `
  SELECT h.ROWID as id, h.id as identifier, h.service
  FROM handle h
  INNER JOIN chat_handle_join chj ON chj.handle_id = h.ROWID
  WHERE chj.chat_id = ?
`;

const SQL_GET_CHAT = `
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
`;

// SQL query for DESC order (newest messages first)
// Matches production query in chat-db.ts stmtGetMessagesDesc
const SQL_GET_MESSAGES_DESC = `
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
  WHERE m.ROWID <= ? AND m.ROWID > ? AND m.item_type IN (0, 1, 2)
  ORDER BY m.ROWID DESC
  LIMIT ?
`;

describe.skipIf(!Database)("ChatDb SQL queries", () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    // Create in-memory database with chat.db schema
    db = new Database!(":memory:");

    // Create tables matching chat.db structure
    db.exec(`
      CREATE TABLE chat (
        ROWID INTEGER PRIMARY KEY,
        chat_identifier TEXT,
        display_name TEXT
      );

      CREATE TABLE handle (
        ROWID INTEGER PRIMARY KEY,
        id TEXT NOT NULL,
        service TEXT DEFAULT 'iMessage'
      );

      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY,
        guid TEXT UNIQUE NOT NULL,
        text TEXT,
        attributedBody BLOB,
        date INTEGER,
        is_from_me INTEGER DEFAULT 0,
        is_sent INTEGER DEFAULT 0,
        is_delivered INTEGER DEFAULT 0,
        is_read INTEGER DEFAULT 0,
        date_read INTEGER,
        error INTEGER DEFAULT 0,
        handle_id INTEGER,
        cache_has_attachments INTEGER DEFAULT 0,
        associated_message_guid TEXT,
        associated_message_type INTEGER DEFAULT 0,
        associated_message_emoji TEXT,
        item_type INTEGER DEFAULT 0,
        FOREIGN KEY (handle_id) REFERENCES handle(ROWID)
      );

      CREATE TABLE chat_message_join (
        chat_id INTEGER,
        message_id INTEGER,
        PRIMARY KEY (chat_id, message_id),
        FOREIGN KEY (chat_id) REFERENCES chat(ROWID),
        FOREIGN KEY (message_id) REFERENCES message(ROWID)
      );

      CREATE TABLE chat_handle_join (
        chat_id INTEGER,
        handle_id INTEGER,
        PRIMARY KEY (chat_id, handle_id),
        FOREIGN KEY (chat_id) REFERENCES chat(ROWID),
        FOREIGN KEY (handle_id) REFERENCES handle(ROWID)
      );
    `);

    // Insert test data
    db.exec(`
      -- Handles (contacts)
      INSERT INTO handle (ROWID, id, service) VALUES (1, '+15551234567', 'iMessage');
      INSERT INTO handle (ROWID, id, service) VALUES (2, '+15559876543', 'SMS');
      INSERT INTO handle (ROWID, id, service) VALUES (3, 'friend@example.com', 'iMessage');

      -- Chats
      INSERT INTO chat (ROWID, chat_identifier, display_name) VALUES (1, 'chat123', 'John Doe');
      INSERT INTO chat (ROWID, chat_identifier, display_name) VALUES (2, 'group-chat456', 'Family Group');

      -- Link handles to chats
      INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1);
      INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (2, 1);
      INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (2, 2);
      INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (2, 3);
    `);
  });

  afterEach(() => {
    db?.close();
  });

  describe("getMessagesSince query", () => {
    it("returns empty array when no messages exist", () => {
      const rows = db.prepare(SQL_GET_MESSAGES_SINCE).all(0);
      expect(rows).toEqual([]);
    });

    it("returns messages since cursor", () => {
      const appleNow = unixToApple(Math.floor(Date.now() / 1000));

      db.exec(`
        INSERT INTO message (ROWID, guid, text, date, is_from_me, is_sent, is_delivered, handle_id)
        VALUES (1, 'guid-1', 'Message 1', ${appleNow - 3000000000000}, 0, 0, 0, 1);

        INSERT INTO message (ROWID, guid, text, date, is_from_me, is_sent, is_delivered, handle_id)
        VALUES (2, 'guid-2', 'Reply from me', ${appleNow - 2000000000000}, 1, 1, 1, NULL);

        INSERT INTO message (ROWID, guid, text, date, is_from_me, is_sent, is_delivered, handle_id)
        VALUES (3, 'guid-3', 'Message 3', ${appleNow - 1000000000000}, 0, 0, 0, 1);

        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 2);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 3);
      `);

      interface MessageRow {
        rowid: number;
        guid: string;
        sender_id: number | null;
        sender_identifier: string | null;
        text: string | null;
        is_from_me: number;
        is_sent: number;
        is_delivered: number;
      }
      const rows = db.prepare(SQL_GET_MESSAGES_SINCE).all(1) as MessageRow[];

      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ rowid: 2, guid: "guid-2", text: "Reply from me", is_from_me: 1, sender_id: null, is_sent: 1 });
      expect(rows[1]).toMatchObject({
        rowid: 3,
        guid: "guid-3",
        text: "Message 3",
        is_from_me: 0,
        sender_id: 1,
        sender_identifier: "+15551234567",
      });
    });

    it("includes group mutability item types and excludes other system metadata", () => {
      const appleNow = unixToApple(Math.floor(Date.now() / 1000));

      db.exec(`
        INSERT INTO message (ROWID, guid, text, date, is_from_me, item_type, handle_id)
        VALUES (10, 'guid-10', 'Normal message', ${appleNow - 4000000000000}, 0, 0, 1);

        INSERT INTO message (ROWID, guid, text, date, is_from_me, item_type, handle_id)
        VALUES (11, 'guid-11', 'Alice added Bob', ${appleNow - 3000000000000}, 0, 1, 1);

        INSERT INTO message (ROWID, guid, text, date, is_from_me, item_type, handle_id)
        VALUES (12, 'guid-12', 'Renamed group', ${appleNow - 2000000000000}, 1, 2, NULL);

        INSERT INTO message (ROWID, guid, text, date, is_from_me, item_type, handle_id)
        VALUES (13, 'guid-13', 'Ignored metadata row', ${appleNow - 1000000000000}, 0, 3, 1);

        INSERT INTO chat_message_join (chat_id, message_id) VALUES (2, 10);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (2, 11);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (2, 12);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (2, 13);
      `);

      interface ItemTypeRow {
        rowid: number;
        guid: string;
        item_type: number;
      }
      const rows = db.prepare(SQL_GET_MESSAGES_SINCE).all(0) as ItemTypeRow[];

      expect(rows.map((r) => r.rowid)).toEqual([10, 11, 12]);
      expect(rows.map((r) => r.item_type)).toEqual([0, 1, 2]);
    });
  });

  describe("getMaxMessageRowid query", () => {
    it("returns 0 when no messages exist", () => {
      const stmt = db.prepare("SELECT MAX(ROWID) as max_rowid FROM message");
      const row = stmt.get() as { max_rowid: number | null };
      expect(row.max_rowid).toBeNull();
    });

    it("returns highest ROWID", () => {
      db.exec(`
        INSERT INTO message (ROWID, guid, text) VALUES (1, 'guid-a', 'msg 1');
        INSERT INTO message (ROWID, guid, text) VALUES (5, 'guid-b', 'msg 5');
        INSERT INTO message (ROWID, guid, text) VALUES (3, 'guid-c', 'msg 3');
      `);

      const stmt = db.prepare("SELECT MAX(ROWID) as max_rowid FROM message");
      const row = stmt.get() as { max_rowid: number };
      expect(row.max_rowid).toBe(5);
    });
  });

  describe("getChatParticipants query", () => {
    it("returns participants for a DM (single participant)", () => {
      const rows = db.prepare(SQL_GET_CHAT_PARTICIPANTS).all(1);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ id: 1, identifier: "+15551234567", service: "iMessage" });
    });

    it("returns participants for a group chat (multiple participants)", () => {
      const rows = db.prepare(SQL_GET_CHAT_PARTICIPANTS).all(2) as { identifier: string }[];
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.identifier)).toEqual(["+15551234567", "+15559876543", "friend@example.com"]);
    });
  });

  describe("getChat query", () => {
    it("returns chat with is_group = false for DM", () => {
      const row = db.prepare(SQL_GET_CHAT).get(1, 1) as Record<string, unknown>;
      expect(row).toMatchObject({ id: 1, identifier: "chat123", name: "John Doe", is_group: 0 });
    });

    it("returns chat with is_group = true for group chat", () => {
      const row = db.prepare(SQL_GET_CHAT).get(2, 2) as Record<string, unknown>;
      expect(row).toMatchObject({ id: 2, identifier: "group-chat456", name: "Family Group", is_group: 1 });
    });
  });

  describe("Apple timestamp conversion", () => {
    it("converts Apple nanosecond timestamp to Unix seconds", () => {
      // Test with a known timestamp: 2024-01-01 00:00:00 UTC
      const unixTimestamp = 1704067200; // 2024-01-01 00:00:00 UTC
      const appleTimestamp =
        (unixTimestamp - APPLE_EPOCH_OFFSET) * 1_000_000_000;

      // Conversion back should give us the original Unix timestamp
      const convertedBack =
        Math.floor(appleTimestamp / 1_000_000_000) + APPLE_EPOCH_OFFSET;
      expect(convertedBack).toBe(unixTimestamp);
    });
  });

  describe("message status fields", () => {
    it("returns status fields for messages", () => {
      const appleNow = unixToApple(Math.floor(Date.now() / 1000));

      db.exec(`
        INSERT INTO message (ROWID, guid, text, date, is_from_me, is_sent, is_delivered, is_read, error, handle_id)
        VALUES (1, 'guid-sent', 'Sent message', ${appleNow - 3000000000000}, 1, 1, 0, 0, 0, NULL);

        INSERT INTO message (ROWID, guid, text, date, is_from_me, is_sent, is_delivered, is_read, error, handle_id)
        VALUES (2, 'guid-delivered', 'Delivered message', ${appleNow - 2000000000000}, 1, 1, 1, 0, 0, NULL);

        INSERT INTO message (ROWID, guid, text, date, is_from_me, is_sent, is_delivered, is_read, error, handle_id)
        VALUES (3, 'guid-read', 'Read message', ${appleNow - 1000000000000}, 1, 1, 1, 1, 0, NULL);

        INSERT INTO message (ROWID, guid, text, date, is_from_me, is_sent, is_delivered, is_read, error, handle_id)
        VALUES (4, 'guid-failed', 'Failed message', ${appleNow}, 1, 0, 0, 0, 22, NULL);

        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 2);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 3);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 4);
      `);

      interface StatusRow {
        guid: string;
        is_sent: number;
        is_delivered: number;
        is_read: number;
        error: number;
      }
      const rows = db.prepare(SQL_GET_MESSAGES_SINCE).all(0) as StatusRow[];

      expect(rows).toHaveLength(4);
      expect(rows[0]).toMatchObject({ guid: "guid-sent", is_sent: 1, is_delivered: 0, is_read: 0, error: 0 });
      expect(rows[1]).toMatchObject({ guid: "guid-delivered", is_sent: 1, is_delivered: 1, is_read: 0, error: 0 });
      expect(rows[2]).toMatchObject({ guid: "guid-read", is_sent: 1, is_delivered: 1, is_read: 1, error: 0 });
      expect(rows[3]).toMatchObject({ guid: "guid-failed", is_sent: 0, is_delivered: 0, is_read: 0, error: 22 });
    });
  });

  describe("reactions (tapbacks)", () => {
    const SQL_GET_REACTIONS = `
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
      WHERE m.associated_message_type BETWEEN 2000 AND 3007
      ORDER BY m.ROWID
    `;

    it("extracts target GUID from associated_message_guid", () => {
      const appleNow = unixToApple(Math.floor(Date.now() / 1000));

      db.exec(`
        INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id, associated_message_guid, associated_message_type)
        VALUES (1, 'target-guid', 'Original message', ${appleNow - 2000000000000}, 0, 1, NULL, 0);

        INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id, associated_message_guid, associated_message_type)
        VALUES (2, 'reaction-guid', NULL, ${appleNow - 1000000000000}, 0, 2, 'p:0/target-guid', 2000);

        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 2);
      `);

      interface ReactionRow {
        rowid: number;
        target_guid: string;
        associated_message_type: number;
        reactor_identifier: string;
        is_from_me: number;
      }
      const rows = db.prepare(SQL_GET_REACTIONS).all() as ReactionRow[];

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        rowid: 2,
        target_guid: "target-guid",
        associated_message_type: 2000, // loved
        reactor_identifier: "+15559876543",
        is_from_me: 0,
      });
    });

    it("filters out tapback messages from regular message query", () => {
      const appleNow = unixToApple(Math.floor(Date.now() / 1000));

      db.exec(`
        INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id, associated_message_type)
        VALUES (1, 'msg-guid', 'Hello', ${appleNow - 2000000000000}, 0, 1, 0);

        INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id, associated_message_guid, associated_message_type)
        VALUES (2, 'tapback-guid', NULL, ${appleNow - 1000000000000}, 1, NULL, 'p:0/msg-guid', 2001);

        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 2);
      `);

      // SQL query returns all messages
      interface AllRow { rowid: number; associated_message_type: number }
      const allRows = db.prepare(SQL_GET_MESSAGES_SINCE).all(0) as AllRow[];
      expect(allRows).toHaveLength(2);

      // Filter out tapbacks (type 2000-3007 are tapbacks)
      const contentRows = allRows.filter(
        (row) =>
          row.associated_message_type === 0 ||
          row.associated_message_type < 2000 ||
          row.associated_message_type > 3007
      );
      expect(contentRows).toHaveLength(1);
      expect(contentRows[0].rowid).toBe(1);
    });

    it("maps tapback types to correct emoji", () => {
      // Test the mapping logic in isolation
      const TAPBACK_TYPE_TO_EMOJI: Record<number, string> = {
        2000: "❤️", // loved
        2001: "👍", // liked
        2002: "👎", // disliked
        2003: "😂", // laughed
        2004: "‼️", // emphasized
        2005: "❓", // questioned
      };

      expect(TAPBACK_TYPE_TO_EMOJI[2000]).toBe("❤️");
      expect(TAPBACK_TYPE_TO_EMOJI[2001]).toBe("👍");
      expect(TAPBACK_TYPE_TO_EMOJI[2002]).toBe("👎");
      expect(TAPBACK_TYPE_TO_EMOJI[2003]).toBe("😂");
      expect(TAPBACK_TYPE_TO_EMOJI[2004]).toBe("‼️");
      expect(TAPBACK_TYPE_TO_EMOJI[2005]).toBe("❓");
    });

    it("includes add and removal tapbacks in row order for reconciliation", () => {
      const appleNow = unixToApple(Math.floor(Date.now() / 1000));

      db.exec(`
        INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id, associated_message_guid, associated_message_type)
        VALUES (1, 'target-guid', 'Original message', ${appleNow - 3000000000000}, 0, 1, NULL, 0);

        INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id, associated_message_guid, associated_message_type)
        VALUES (2, 'reaction-add', NULL, ${appleNow - 2000000000000}, 0, 2, 'p:0/target-guid', 2001);

        INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id, associated_message_guid, associated_message_type)
        VALUES (3, 'reaction-remove', NULL, ${appleNow - 1000000000000}, 0, 2, 'p:0/target-guid', 3001);

        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 2);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 3);
      `);

      interface ReactionRow {
        rowid: number;
        associated_message_type: number;
      }
      const rows = db.prepare(SQL_GET_REACTIONS).all() as ReactionRow[];

      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ rowid: 2, associated_message_type: 2001 });
      expect(rows[1]).toMatchObject({ rowid: 3, associated_message_type: 3001 });
    });
  });

  describe("getMessagesDescending query (DESC order for full sync)", () => {
    it("returns empty array when no messages exist", () => {
      const rows = db.prepare(SQL_GET_MESSAGES_DESC).all(1000, 0, 100);
      expect(rows).toEqual([]);
    });

    it("returns messages in DESC order (newest first)", () => {
      const appleNow = unixToApple(Math.floor(Date.now() / 1000));

      db.exec(`
        INSERT INTO message (ROWID, guid, text, date, is_from_me, is_sent, is_delivered, handle_id)
        VALUES (1, 'guid-1', 'Oldest message', ${appleNow - 3000000000000}, 0, 0, 0, 1);

        INSERT INTO message (ROWID, guid, text, date, is_from_me, is_sent, is_delivered, handle_id)
        VALUES (2, 'guid-2', 'Middle message', ${appleNow - 2000000000000}, 0, 0, 0, 1);

        INSERT INTO message (ROWID, guid, text, date, is_from_me, is_sent, is_delivered, handle_id)
        VALUES (3, 'guid-3', 'Newest message', ${appleNow - 1000000000000}, 0, 0, 0, 1);

        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 2);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 3);
      `);

      interface MessageRow {
        rowid: number;
        guid: string;
        text: string | null;
      }
      // maxRowid=3, minRowid=0, limit=100 → should return all 3 in DESC order
      const rows = db.prepare(SQL_GET_MESSAGES_DESC).all(3, 0, 100) as MessageRow[];

      expect(rows).toHaveLength(3);
      // DESC order: newest (ROWID 3) first, oldest (ROWID 1) last
      expect(rows[0]).toMatchObject({ rowid: 3, guid: "guid-3", text: "Newest message" });
      expect(rows[1]).toMatchObject({ rowid: 2, guid: "guid-2", text: "Middle message" });
      expect(rows[2]).toMatchObject({ rowid: 1, guid: "guid-1", text: "Oldest message" });
    });

    it("respects maxRowid upper bound (inclusive)", () => {
      const appleNow = unixToApple(Math.floor(Date.now() / 1000));

      db.exec(`
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (1, 'guid-1', 'Msg 1', ${appleNow - 4000000000000}, 1);
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (2, 'guid-2', 'Msg 2', ${appleNow - 3000000000000}, 1);
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (3, 'guid-3', 'Msg 3', ${appleNow - 2000000000000}, 1);
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (4, 'guid-4', 'Msg 4', ${appleNow - 1000000000000}, 1);

        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 2);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 3);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 4);
      `);

      interface MessageRow { rowid: number }
      // maxRowid=2 → should only return ROWID 1 and 2 (not 3 or 4)
      const rows = db.prepare(SQL_GET_MESSAGES_DESC).all(2, 0, 100) as MessageRow[];

      expect(rows).toHaveLength(2);
      expect(rows[0].rowid).toBe(2);
      expect(rows[1].rowid).toBe(1);
    });

    it("respects minRowid lower bound (exclusive)", () => {
      const appleNow = unixToApple(Math.floor(Date.now() / 1000));

      db.exec(`
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (1, 'guid-1', 'Msg 1', ${appleNow - 4000000000000}, 1);
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (2, 'guid-2', 'Msg 2', ${appleNow - 3000000000000}, 1);
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (3, 'guid-3', 'Msg 3', ${appleNow - 2000000000000}, 1);
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (4, 'guid-4', 'Msg 4', ${appleNow - 1000000000000}, 1);

        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 2);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 3);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 4);
      `);

      interface MessageRow { rowid: number }
      // minRowid=2 → should exclude ROWID 1 and 2, only return 3 and 4
      const rows = db.prepare(SQL_GET_MESSAGES_DESC).all(4, 2, 100) as MessageRow[];

      expect(rows).toHaveLength(2);
      expect(rows[0].rowid).toBe(4);
      expect(rows[1].rowid).toBe(3);
    });

    it("respects limit parameter", () => {
      const appleNow = unixToApple(Math.floor(Date.now() / 1000));

      db.exec(`
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (1, 'guid-1', 'Msg 1', ${appleNow - 5000000000000}, 1);
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (2, 'guid-2', 'Msg 2', ${appleNow - 4000000000000}, 1);
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (3, 'guid-3', 'Msg 3', ${appleNow - 3000000000000}, 1);
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (4, 'guid-4', 'Msg 4', ${appleNow - 2000000000000}, 1);
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (5, 'guid-5', 'Msg 5', ${appleNow - 1000000000000}, 1);

        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 2);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 3);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 4);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 5);
      `);

      interface MessageRow { rowid: number }
      // limit=2 → should only return 2 newest messages
      const rows = db.prepare(SQL_GET_MESSAGES_DESC).all(5, 0, 2) as MessageRow[];

      expect(rows).toHaveLength(2);
      expect(rows[0].rowid).toBe(5); // Newest
      expect(rows[1].rowid).toBe(4); // Second newest
    });

    it("filters out tapback reactions in DESC order", () => {
      const appleNow = unixToApple(Math.floor(Date.now() / 1000));

      db.exec(`
        INSERT INTO message (ROWID, guid, text, date, handle_id, associated_message_type)
        VALUES (1, 'msg-guid', 'Hello', ${appleNow - 2000000000000}, 1, 0);

        INSERT INTO message (ROWID, guid, text, date, handle_id, associated_message_guid, associated_message_type)
        VALUES (2, 'tapback-guid', NULL, ${appleNow - 1000000000000}, 1, 'p:0/msg-guid', 2001);

        INSERT INTO message (ROWID, guid, text, date, handle_id, associated_message_type)
        VALUES (3, 'msg-guid-2', 'Hi there', ${appleNow}, 1, 0);

        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 2);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 3);
      `);

      interface MessageRow { rowid: number; associated_message_type: number }
      const allRows = db.prepare(SQL_GET_MESSAGES_DESC).all(3, 0, 100) as MessageRow[];
      expect(allRows).toHaveLength(3);

      // Filter out tapbacks (type 2000-3007)
      const contentRows = allRows.filter(
        (row) =>
          row.associated_message_type < 2000 ||
          row.associated_message_type > 3007
      );
      expect(contentRows).toHaveLength(2);
      // DESC order: ROWID 3 first, ROWID 1 second
      expect(contentRows[0].rowid).toBe(3);
      expect(contentRows[1].rowid).toBe(1);
    });
  });

  describe("buildSyncBatchDescending cursor calculation", () => {
    it("cursor should be lowest ROWID - 1 for DESC iteration", () => {
      // This tests the cursor semantics for DESC sync
      // After processing a batch with messages ROWID 5,4,3, cursor should be 2 (lowest - 1)
      // Next batch would then fetch WHERE ROWID <= 2 AND ROWID > 0

      const appleNow = unixToApple(Math.floor(Date.now() / 1000));

      db.exec(`
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (1, 'guid-1', 'Msg 1', ${appleNow - 5000000000000}, 1);
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (2, 'guid-2', 'Msg 2', ${appleNow - 4000000000000}, 1);
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (3, 'guid-3', 'Msg 3', ${appleNow - 3000000000000}, 1);
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (4, 'guid-4', 'Msg 4', ${appleNow - 2000000000000}, 1);
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (5, 'guid-5', 'Msg 5', ${appleNow - 1000000000000}, 1);

        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 2);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 3);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 4);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 5);
      `);

      interface MessageRow { rowid: number }

      // First batch: maxRowid=5, minRowid=0, limit=3
      const batch1 = db.prepare(SQL_GET_MESSAGES_DESC).all(5, 0, 3) as MessageRow[];
      expect(batch1).toHaveLength(3);
      expect(batch1.map(r => r.rowid)).toEqual([5, 4, 3]);

      // Cursor calculation: lowest ROWID in batch - 1 = 3 - 1 = 2
      const lowestRowid = batch1[batch1.length - 1].rowid;
      const cursor = lowestRowid - 1;
      expect(cursor).toBe(2);

      // Second batch: maxRowid=cursor(2), minRowid=0, limit=3
      const batch2 = db.prepare(SQL_GET_MESSAGES_DESC).all(cursor, 0, 3) as MessageRow[];
      expect(batch2).toHaveLength(2);
      expect(batch2.map(r => r.rowid)).toEqual([2, 1]);

      // Cursor after batch2: lowest ROWID - 1 = 1 - 1 = 0
      const cursor2 = batch2[batch2.length - 1].rowid - 1;
      expect(cursor2).toBe(0);

      // Third batch: maxRowid=0 should return nothing
      const batch3 = db.prepare(SQL_GET_MESSAGES_DESC).all(cursor2, 0, 3) as MessageRow[];
      expect(batch3).toHaveLength(0);
    });

    it("parallel DESC batches calculate cursors correctly", () => {
      // Simulate parallel batch processing for DESC sync
      // 5 messages, 3 batches processed in parallel

      const appleNow = unixToApple(Math.floor(Date.now() / 1000));

      db.exec(`
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (1, 'guid-1', 'Msg 1', ${appleNow - 10000000000000}, 1);
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (2, 'guid-2', 'Msg 2', ${appleNow - 9000000000000}, 1);
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (3, 'guid-3', 'Msg 3', ${appleNow - 8000000000000}, 1);
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (4, 'guid-4', 'Msg 4', ${appleNow - 7000000000000}, 1);
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (5, 'guid-5', 'Msg 5', ${appleNow - 6000000000000}, 1);
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (6, 'guid-6', 'Msg 6', ${appleNow - 5000000000000}, 1);
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (7, 'guid-7', 'Msg 7', ${appleNow - 4000000000000}, 1);
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (8, 'guid-8', 'Msg 8', ${appleNow - 3000000000000}, 1);
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (9, 'guid-9', 'Msg 9', ${appleNow - 2000000000000}, 1);
        INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (10, 'guid-10', 'Msg 10', ${appleNow - 1000000000000}, 1);

        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 2);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 3);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 4);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 5);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 6);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 7);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 8);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 9);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 10);
      `);

      interface MessageRow { rowid: number }

      // Simulate reading 3 batches ahead for parallel processing
      let tempCursor = 10; // Start from maxRowid
      const batches: { rows: MessageRow[]; cursor: number }[] = [];

      for (let i = 0; i < 3 && tempCursor > 0; i++) {
        const rows = db.prepare(SQL_GET_MESSAGES_DESC).all(tempCursor, 0, 3) as MessageRow[];
        if (rows.length === 0) break;
        const cursor = rows[rows.length - 1].rowid - 1;
        batches.push({ rows, cursor });
        tempCursor = cursor;
      }

      expect(batches).toHaveLength(3);

      // Batch 1: ROWIDs 10, 9, 8 → cursor = 7
      expect(batches[0].rows.map(r => r.rowid)).toEqual([10, 9, 8]);
      expect(batches[0].cursor).toBe(7);

      // Batch 2: ROWIDs 7, 6, 5 → cursor = 4
      expect(batches[1].rows.map(r => r.rowid)).toEqual([7, 6, 5]);
      expect(batches[1].cursor).toBe(4);

      // Batch 3: ROWIDs 4, 3, 2 → cursor = 1
      expect(batches[2].rows.map(r => r.rowid)).toEqual([4, 3, 2]);
      expect(batches[2].cursor).toBe(1);

      // After parallel processing, overall cursor = min of all batch cursors = 1
      const overallCursor = Math.min(...batches.map(b => b.cursor));
      expect(overallCursor).toBe(1);
    });
  });
});
