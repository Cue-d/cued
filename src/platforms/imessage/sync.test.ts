import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCallHistoryBatch } from "./call-history.js";
import { buildIMessageSyncBundle, resolveIMessageLoader } from "./sync.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

describe("imessage worker loader resolution", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function createSyntheticChatDb(
    messageCount: number,
    options?: { filteredRowIds?: number[]; attachmentRowIds?: number[] },
  ): string {
    const dir = createTempDir("cued-imessage-db-");
    const dbPath = join(dir, "chat.db");
    const db = new DatabaseSync(dbPath);
    const filteredRowIds = new Set(options?.filteredRowIds ?? []);
    const attachmentRowIds = new Set(options?.attachmentRowIds ?? []);

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
      CREATE TABLE attachment (
        guid TEXT NOT NULL,
        filename TEXT,
        uti TEXT,
        mime_type TEXT,
        transfer_name TEXT,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        is_sticker INTEGER NOT NULL DEFAULT 0,
        hide_attachment INTEGER NOT NULL DEFAULT 0,
        ck_record_id TEXT
      );
      CREATE TABLE message_attachment_join (
        message_id INTEGER NOT NULL,
        attachment_id INTEGER NOT NULL
      );
    `);

    db.prepare("INSERT INTO handle (id, service) VALUES (?, ?)").run("+14155550123", "iMessage");
    db.prepare("INSERT INTO chat (chat_identifier, display_name) VALUES (?, ?)").run(
      "chat-1",
      null,
    );
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
    const insertChatJoin = db.prepare(
      "INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)",
    );
    const insertAttachment = db.prepare(`
      INSERT INTO attachment (
        guid,
        filename,
        uti,
        mime_type,
        transfer_name,
        total_bytes,
        is_sticker,
        hide_attachment,
        ck_record_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAttachmentJoin = db.prepare(
      "INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)",
    );

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
      if (attachmentRowIds.has(index)) {
        insertAttachment.run(
          `attachment-${index}`,
          `~/Library/Messages/Attachments/${index}/file-${index}.pdf`,
          "com.adobe.pdf",
          "application/pdf",
          `file-${index}.pdf`,
          2_048,
          0,
          0,
          `record-${index}`,
        );
        insertAttachmentJoin.run(index, index);
      }
    }

    db.close();
    return dbPath;
  }

  function createSyntheticCallHistoryDb(
    calls: Array<{
      pk: number;
      uniqueId: string;
      dateValue: number;
      durationSeconds: number;
      address: string | null;
      name?: string | null;
      serviceProvider?: string | null;
      callType?: number | null;
      originated?: number | null;
      answered?: number | null;
      disconnectedCause?: number | null;
    }> = [],
  ): string {
    const dir = createTempDir("cued-callhistory-db-");
    const dbPath = join(dir, "CallHistory.storedata");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE ZCALLRECORD (
        Z_PK INTEGER PRIMARY KEY,
        ZUNIQUE_ID TEXT,
        ZDATE REAL,
        ZDURATION REAL,
        ZADDRESS TEXT,
        ZNAME TEXT,
        ZSERVICE_PROVIDER TEXT,
        ZCALLTYPE INTEGER,
        ZORIGINATED INTEGER,
        ZANSWERED INTEGER,
        ZDISCONNECTED_CAUSE INTEGER,
        ZHANDLE_TYPE INTEGER,
        ZCALL_CATEGORY INTEGER
      );
    `);

    const insertCall = db.prepare(`
      INSERT INTO ZCALLRECORD (
        Z_PK,
        ZUNIQUE_ID,
        ZDATE,
        ZDURATION,
        ZADDRESS,
        ZNAME,
        ZSERVICE_PROVIDER,
        ZCALLTYPE,
        ZORIGINATED,
        ZANSWERED,
        ZDISCONNECTED_CAUSE,
        ZHANDLE_TYPE,
        ZCALL_CATEGORY
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const call of calls) {
      insertCall.run(
        call.pk,
        call.uniqueId,
        call.dateValue,
        call.durationSeconds,
        call.address,
        call.name ?? null,
        call.serviceProvider ?? "com.apple.Telephony",
        call.callType ?? 1,
        call.originated ?? 0,
        call.answered ?? 0,
        call.disconnectedCause ?? null,
        2,
        1,
      );
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
    const callHistoryPath = createSyntheticCallHistoryDb();
    const repoRoot = createTempDir("cued-imessage-repo-");
    const env = { CUED_IMESSAGE_DB_PATH: chatDbPath };

    const first = buildIMessageSyncBundle({
      path: chatDbPath,
      callHistoryPath,
      limit: 500,
      env,
      repoRoot,
    });
    expect(first.hasMore).toBe(true);
    expect(first.syncMode).toBe("full");
    expect(first.sourceCursor).toEqual({ rowId: 500, callPk: 0 });

    const second = buildIMessageSyncBundle({
      path: chatDbPath,
      callHistoryPath,
      lastRowId: 500,
      limit: 500,
      env,
      repoRoot,
    });
    expect(second.hasMore).toBe(false);
    expect(second.syncMode).toBe("incremental");
    expect(second.sourceCursor).toEqual({ rowId: 650, callPk: 0 });
  });

  it("keeps paging when the fetched batch includes filtered tapback rows", () => {
    const chatDbPath = createSyntheticChatDb(650, { filteredRowIds: [500] });
    const callHistoryPath = createSyntheticCallHistoryDb();
    const repoRoot = createTempDir("cued-imessage-repo-");
    const env = { CUED_IMESSAGE_DB_PATH: chatDbPath };

    const first = buildIMessageSyncBundle({
      path: chatDbPath,
      callHistoryPath,
      limit: 500,
      env,
      repoRoot,
    });
    expect(first.rawEvents.some((event) => event.entityKind === "message")).toBe(true);
    expect(first.hasMore).toBe(true);
    expect(first.sourceCursor).toEqual({ rowId: 500, callPk: 0 });

    const second = buildIMessageSyncBundle({
      path: chatDbPath,
      callHistoryPath,
      lastRowId: 500,
      limit: 500,
      env,
      repoRoot,
    });
    expect(second.hasMore).toBe(false);
    expect(second.syncMode).toBe("incremental");
    expect(second.sourceCursor).toEqual({ rowId: 650, callPk: 0 });
  });

  it("projects iMessage attachment metadata when the chat db has local attachment rows", () => {
    const chatDbPath = createSyntheticChatDb(1, { attachmentRowIds: [1] });
    const callHistoryPath = createSyntheticCallHistoryDb();
    const repoRoot = createTempDir("cued-imessage-repo-");
    const env = { CUED_IMESSAGE_DB_PATH: chatDbPath };

    const bundle = buildIMessageSyncBundle({
      path: chatDbPath,
      callHistoryPath,
      env,
      repoRoot,
    });

    const messageEvent = bundle.rawEvents.find((event) => event.entityKind === "message");
    expect(messageEvent?.payload).toEqual(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            kind: "file",
            filename: "file-1.pdf",
            local_path: "~/Library/Messages/Attachments/1/file-1.pdf",
            mime_type: "application/pdf",
            access_kind: "local_path",
          }),
        ],
      }),
    );
  });

  it("projects local call history as call raw events and maps matching direct chats", () => {
    const chatDbPath = createSyntheticChatDb(1);
    const callHistoryPath = createSyntheticCallHistoryDb([
      {
        pk: 7,
        uniqueId: "call-7",
        dateValue: 10,
        durationSeconds: 75,
        address: "+14155550123",
        serviceProvider: "com.apple.FaceTime",
        callType: 8,
        originated: 0,
        answered: 1,
      },
    ]);
    const repoRoot = createTempDir("cued-imessage-repo-");
    const env = { CUED_IMESSAGE_DB_PATH: chatDbPath };

    const bundle = buildIMessageSyncBundle({
      path: chatDbPath,
      callHistoryPath,
      env,
      repoRoot,
    });

    const callEvent = bundle.rawEvents.find((event) => event.entityKind === "call");
    expect(callEvent?.payload).toEqual(
      expect.objectContaining({
        sourceCallKey: "call-7",
        sourceConversationKey: "1",
        provider: "facetime",
        medium: "video",
        status: "completed",
        primaryRemoteSourceKey: "imessage:+14155550123",
        durationSeconds: 75,
      }),
    );
    expect(bundle.sourceCursor).toEqual({ rowId: 1, callPk: 7 });
  });

  it("keeps short unanswered outgoing calls as canceled instead of completed", () => {
    const chatDbPath = createSyntheticChatDb(1);
    const callHistoryPath = createSyntheticCallHistoryDb([
      {
        pk: 8,
        uniqueId: "call-8",
        dateValue: 12,
        durationSeconds: 3,
        address: "+14155550123",
        serviceProvider: "com.apple.FaceTime",
        callType: 8,
        originated: 1,
        answered: 0,
      },
    ]);
    const repoRoot = createTempDir("cued-imessage-repo-");
    const env = { CUED_IMESSAGE_DB_PATH: chatDbPath };

    const bundle = buildIMessageSyncBundle({
      path: chatDbPath,
      callHistoryPath,
      env,
      repoRoot,
    });

    const callEvent = bundle.rawEvents.find((event) => event.entityKind === "call");
    expect(callEvent?.payload).toEqual(
      expect.objectContaining({
        sourceCallKey: "call-8",
        status: "canceled",
        direction: "outgoing",
        durationSeconds: 3,
      }),
    );
  });

  it("loads call history without chat db mapping when the messages db is missing", () => {
    const callHistoryPath = createSyntheticCallHistoryDb([
      {
        pk: 9,
        uniqueId: "call-9",
        dateValue: 14,
        durationSeconds: 0,
        address: "+14155550123",
      },
    ]);
    const batch = loadCallHistoryBatch({
      path: callHistoryPath,
      chatDbPath: join(createTempDir("cued-imessage-repo-"), "missing-chat.db"),
    });

    expect(batch.calls).toContainEqual(
      expect.objectContaining({
        sourceCallKey: "call-9",
        sourceConversationKey: "call:imessage:+14155550123",
        remoteSourceKey: "imessage:+14155550123",
      }),
    );
  });

  it("preserves non-dialable caller labels in synthetic identities", () => {
    const callHistoryPath = createSyntheticCallHistoryDb([
      {
        pk: 10,
        uniqueId: "call-10",
        dateValue: 16,
        durationSeconds: 0,
        address: "Unknown",
      },
    ]);
    const batch = loadCallHistoryBatch({
      path: callHistoryPath,
      chatDbPath: join(createTempDir("cued-imessage-repo-"), "missing-chat.db"),
    });

    expect(batch.calls).toContainEqual(
      expect.objectContaining({
        sourceCallKey: "call-10",
        sourceConversationKey: "call:imessage:Unknown",
        remoteSourceKey: "imessage:Unknown",
        remoteAddress: "Unknown",
      }),
    );
  });
});
