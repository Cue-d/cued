import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { buildIMessageSyncBundle, resolveIMessageLoader } from "../workers/imessage-worker-lib.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

describe("imessage worker loader resolution", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function createSyntheticChatDb(
    messageCount: number,
    options?: { filteredRowIds?: number[] },
  ): string {
    const dir = createTempDir("cued-imessage-db-");
    const dbPath = join(dir, "chat.db");
    const db = new DatabaseSync(dbPath);
    const filteredRowIds = new Set(options?.filteredRowIds ?? []);

    db.exec(`
      CREATE TABLE handle (
        id TEXT NOT NULL,
        service TEXT NOT NULL
      );
      CREATE TABLE chat (
        chat_identifier TEXT NOT NULL,
        display_name TEXT
      );
      CREATE TABLE chat_handle_join (
        chat_id INTEGER NOT NULL,
        handle_id INTEGER NOT NULL
      );
      CREATE TABLE message (
        guid TEXT NOT NULL,
        handle_id INTEGER,
        text TEXT,
        attributedBody BLOB,
        date INTEGER,
        is_from_me INTEGER NOT NULL DEFAULT 0,
        is_sent INTEGER NOT NULL DEFAULT 1,
        is_delivered INTEGER NOT NULL DEFAULT 1,
        is_read INTEGER NOT NULL DEFAULT 0,
        date_read INTEGER,
        error INTEGER NOT NULL DEFAULT 0,
        cache_has_attachments INTEGER NOT NULL DEFAULT 0,
        item_type INTEGER NOT NULL DEFAULT 0,
        associated_message_type INTEGER NOT NULL DEFAULT 0,
        associated_message_emoji TEXT,
        associated_message_guid TEXT
      );
      CREATE TABLE chat_message_join (
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL
      );
    `);

    db.prepare("INSERT INTO handle (id, service) VALUES (?, ?)").run("+14155550123", "iMessage");
    db.prepare("INSERT INTO chat (chat_identifier, display_name) VALUES (?, ?)").run("chat-1", null);
    db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)").run(1, 1);

    const insertMessage = db.prepare(`
      INSERT INTO message (
        guid,
        handle_id,
        text,
        attributedBody,
        date,
        is_from_me,
        is_sent,
        is_delivered,
        is_read,
        date_read,
        error,
        cache_has_attachments,
        item_type,
        associated_message_type,
        associated_message_emoji,
        associated_message_guid
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertChatJoin = db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)");

    for (let index = 1; index <= messageCount; index += 1) {
      insertMessage.run(
        `message-${index}`,
        1,
        filteredRowIds.has(index) ? null : `hello ${index}`,
        null,
        index * 1_000_000_000,
        0,
        1,
        1,
        0,
        null,
        0,
        0,
        0,
        filteredRowIds.has(index) ? 2001 : 0,
        null,
        null,
      );
      insertChatJoin.run(1, index);
    }

    db.close();
    return dbPath;
  }

  it("prefers explicit native binary overrides", () => {
    expect(
      resolveIMessageLoader(
        {
          CUED_IMESSAGE_NATIVE_BINARY: "/tmp/CuedNative",
          CUED_IMESSAGE_DB_PATH: "/tmp/chat.db",
        },
        "/tmp/repo",
      ),
    ).toEqual({
      kind: "native",
      path: "/tmp/CuedNative",
    });
  });

  it("falls back to the TypeScript reader path without a native binary", () => {
    expect(
      resolveIMessageLoader(
        {
          CUED_IMESSAGE_DB_PATH: "/tmp/chat.db",
        },
        "/tmp/repo",
      ),
    ).toEqual({
      kind: "ts",
      path: "/tmp/chat.db",
    });
  });

  it("marks multi-page initial syncs as full until the final page", () => {
    const chatDbPath = createSyntheticChatDb(650);
    const repoRoot = createTempDir("cued-imessage-repo-");
    const env = { CUED_IMESSAGE_DB_PATH: chatDbPath };

    const first = buildIMessageSyncBundle({
      path: chatDbPath,
      limit: 500,
      env,
      repoRoot,
    });
    expect(first.hasMore).toBe(true);
    expect(first.syncMode).toBe("full");
    expect(first.sourceCursor).toEqual({ rowId: 500 });

    const second = buildIMessageSyncBundle({
      path: chatDbPath,
      lastRowId: 500,
      limit: 500,
      env,
      repoRoot,
    });
    expect(second.hasMore).toBe(false);
    expect(second.syncMode).toBe("incremental");
    expect(second.sourceCursor).toEqual({ rowId: 650 });
  });

  it("keeps paging when the fetched batch includes filtered tapback rows", () => {
    const chatDbPath = createSyntheticChatDb(650, { filteredRowIds: [500] });
    const repoRoot = createTempDir("cued-imessage-repo-");
    const env = { CUED_IMESSAGE_DB_PATH: chatDbPath };

    const first = buildIMessageSyncBundle({
      path: chatDbPath,
      limit: 500,
      env,
      repoRoot,
    });
    expect(first.rawEvents.some((event) => event.entityKind === "message")).toBe(true);
    expect(first.hasMore).toBe(true);
    expect(first.sourceCursor).toEqual({ rowId: 500 });

    const second = buildIMessageSyncBundle({
      path: chatDbPath,
      lastRowId: 500,
      limit: 500,
      env,
      repoRoot,
    });
    expect(second.hasMore).toBe(false);
    expect(second.syncMode).toBe("incremental");
    expect(second.sourceCursor).toEqual({ rowId: 650 });
  });
});
