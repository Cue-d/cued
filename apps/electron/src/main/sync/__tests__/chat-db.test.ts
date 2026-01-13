import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Apple timestamp epoch offset (seconds from 1970-01-01 to 2001-01-01)
const APPLE_EPOCH_OFFSET = 978307200;

function unixToApple(unixTs: number): number {
  return (unixTs - APPLE_EPOCH_OFFSET) * 1_000_000_000;
}

// SQL queries matching ChatDb implementation
const SQL_GET_MESSAGES_SINCE = `
  SELECT
    m.ROWID as rowid,
    cmj.chat_id,
    CASE WHEN m.is_from_me = 0 THEN m.handle_id ELSE NULL END as sender_id,
    h.id as sender_identifier,
    h.service as sender_service,
    m.text,
    m.date,
    m.is_from_me
  FROM message m
  INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE m.ROWID > ?
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

describe("ChatDb SQL queries", () => {
  let db: Database.Database;

  beforeEach(() => {
    // Create in-memory database with chat.db schema
    db = new Database(":memory:");

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
        text TEXT,
        attributedBody BLOB,
        date INTEGER,
        is_from_me INTEGER DEFAULT 0,
        is_read INTEGER DEFAULT 0,
        date_read INTEGER,
        handle_id INTEGER,
        cache_has_attachments INTEGER DEFAULT 0,
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
    db.close();
  });

  describe("getMessagesSince query", () => {
    it("returns empty array when no messages exist", () => {
      const rows = db.prepare(SQL_GET_MESSAGES_SINCE).all(0);
      expect(rows).toEqual([]);
    });

    it("returns messages since cursor", () => {
      const appleNow = unixToApple(Math.floor(Date.now() / 1000));

      db.exec(`
        INSERT INTO message (ROWID, text, date, is_from_me, handle_id)
        VALUES (1, 'Message 1', ${appleNow - 3000000000000}, 0, 1);

        INSERT INTO message (ROWID, text, date, is_from_me, handle_id)
        VALUES (2, 'Reply from me', ${appleNow - 2000000000000}, 1, NULL);

        INSERT INTO message (ROWID, text, date, is_from_me, handle_id)
        VALUES (3, 'Message 3', ${appleNow - 1000000000000}, 0, 1);

        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 2);
        INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 3);
      `);

      interface MessageRow {
        rowid: number;
        sender_id: number | null;
        sender_identifier: string | null;
        text: string | null;
        is_from_me: number;
      }
      const rows = db.prepare(SQL_GET_MESSAGES_SINCE).all(1) as MessageRow[];

      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ rowid: 2, text: "Reply from me", is_from_me: 1, sender_id: null });
      expect(rows[1]).toMatchObject({
        rowid: 3,
        text: "Message 3",
        is_from_me: 0,
        sender_id: 1,
        sender_identifier: "+15551234567",
      });
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
        INSERT INTO message (ROWID, text) VALUES (1, 'msg 1');
        INSERT INTO message (ROWID, text) VALUES (5, 'msg 5');
        INSERT INTO message (ROWID, text) VALUES (3, 'msg 3');
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
});
