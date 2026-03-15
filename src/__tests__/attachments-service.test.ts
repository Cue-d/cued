import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fetchAttachment, listAttachments, searchAttachments } from "../attachments/service.js";
import { CuedDatabase } from "../db/database.js";

describe("attachment service", () => {
  const tempDirs: string[] = [];
  const cleanupPaths: string[] = [];
  const originalHome = process.env.HOME;

  afterEach(() => {
    process.env.HOME = originalHome;
    while (cleanupPaths.length > 0) {
      const path = cleanupPaths.pop();
      if (path) {
        rmSync(path, { force: true });
      }
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createDb(): CuedDatabase {
    const dir = mkdtempSync(join(tmpdir(), "cued-attachments-db-"));
    tempDirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
    return db;
  }

  function sqlite(db: CuedDatabase) {
    return (
      db as unknown as {
        sqlite: {
          prepare: (sql: string) => {
            run: (...params: unknown[]) => void;
          };
        };
      }
    ).sqlite;
  }

  it("fetches a local attachment into cache, extracts text, and makes it searchable", async () => {
    const db = createDb();
    const fileDir = mkdtempSync(join(tmpdir(), "cued-attachments-src-"));
    tempDirs.push(fileDir);
    const sourcePath = join(fileDir, "note.txt");
    writeFileSync(sourcePath, "attachment alpha beta gamma\n");

    const timestamp = Date.now();
    const sql = sqlite(db);
    sql
      .prepare(
        `
        INSERT INTO conversations (
          id, platform, account_key, source_conversation_key, native_conversation_key, type, subtype,
          service, name, topic, participant_names, last_message_id, last_message_at, last_message_preview,
          unread_count, created_at, updated_at
        ) VALUES (?, 'imessage', 'local', ?, NULL, 'dm', NULL, 'iMessage', ?, NULL, '', NULL, NULL, NULL, 0, ?, ?)
      `,
      )
      .run("conversation-1", "source-conversation-1", "Thread", timestamp, timestamp);
    sql
      .prepare(
        `
        INSERT INTO messages (
          id, platform, account_key, platform_message_id, conversation_id, sender_contact_id,
          sender_source_key, sender_name, conversation_name, sent_at, service, status, is_from_me,
          content, delivered_at, read_at, edited_at, deleted_at, reply_to_message_id, is_deleted,
          is_edited, attachment_count, reaction_count, created_at, updated_at
        ) VALUES (?, 'imessage', 'local', ?, ?, NULL, NULL, 'Ben', 'Thread', ?, 'iMessage', 'delivered', 0, 'hello', NULL, NULL, NULL, NULL, NULL, 0, 0, 1, 0, ?, ?)
      `,
      )
      .run("message-1", "platform-message-1", "conversation-1", timestamp, timestamp, timestamp);
    sql
      .prepare(
        `
        INSERT INTO message_attachments (
          id, message_id, platform, account_key, source_attachment_key, kind, mime_type, filename,
          title, local_path, remote_url, size_bytes, text_content, access_kind, access_ref_json,
          preview_ref_json, availability_status, provider_metadata_json, metadata_json, created_at, updated_at
        ) VALUES (?, ?, 'imessage', 'local', ?, 'file', 'text/plain', 'note.txt', 'Note', ?, NULL, ?, NULL, 'local_path', ?, NULL, 'available', '{}', '{}', ?, ?)
      `,
      )
      .run(
        "attachment-1",
        "message-1",
        "source-attachment-1",
        sourcePath,
        28,
        JSON.stringify({ path: sourcePath }),
        timestamp,
        timestamp,
      );

    const listed = listAttachments(db, { messageId: "message-1" });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.attachment.access_kind).toBe("local_path");

    const fetched = await fetchAttachment(db, {
      attachmentId: "attachment-1",
    });
    if (fetched.localPath) {
      cleanupPaths.push(fetched.localPath);
    }
    expect(fetched.cacheHit).toBe(false);
    expect(fetched.localPath).toBeTruthy();
    expect(fetched.content).toEqual(
      expect.objectContaining({
        status: "ready",
        hasText: true,
      }),
    );

    const second = await fetchAttachment(db, {
      attachmentId: "attachment-1",
    });
    expect(second.cacheHit).toBe(true);

    const searchResults = searchAttachments(db, { query: "alpha" });
    expect(searchResults).toEqual([
      expect.objectContaining({
        attachmentId: "attachment-1",
        messageId: "message-1",
      }),
    ]);

    db.close();
  });

  it("returns cache metadata for the requested non-default variant", async () => {
    const db = createDb();
    const fileDir = mkdtempSync(join(tmpdir(), "cued-attachments-variant-"));
    tempDirs.push(fileDir);
    const sourcePath = join(fileDir, "variant.txt");
    writeFileSync(sourcePath, "variant attachment\n");

    const timestamp = Date.now();
    const sql = sqlite(db);
    sql
      .prepare(
        `
        INSERT INTO conversations (
          id, platform, account_key, source_conversation_key, native_conversation_key, type, subtype,
          service, name, topic, participant_names, last_message_id, last_message_at, last_message_preview,
          unread_count, created_at, updated_at
        ) VALUES (?, 'imessage', 'local', ?, NULL, 'dm', NULL, 'iMessage', ?, NULL, '', NULL, NULL, NULL, 0, ?, ?)
      `,
      )
      .run("conversation-variant", "source-conversation-variant", "Thread", timestamp, timestamp);
    sql
      .prepare(
        `
        INSERT INTO messages (
          id, platform, account_key, platform_message_id, conversation_id, sender_contact_id,
          sender_source_key, sender_name, conversation_name, sent_at, service, status, is_from_me,
          content, delivered_at, read_at, edited_at, deleted_at, reply_to_message_id, is_deleted,
          is_edited, attachment_count, reaction_count, created_at, updated_at
        ) VALUES (?, 'imessage', 'local', ?, ?, NULL, NULL, 'Ben', 'Thread', ?, 'iMessage', 'delivered', 0, 'hello', NULL, NULL, NULL, NULL, NULL, 0, 0, 1, 0, ?, ?)
      `,
      )
      .run(
        "message-variant",
        "platform-message-variant",
        "conversation-variant",
        timestamp,
        timestamp,
        timestamp,
      );
    sql
      .prepare(
        `
        INSERT INTO message_attachments (
          id, message_id, platform, account_key, source_attachment_key, kind, mime_type, filename,
          title, local_path, remote_url, size_bytes, text_content, access_kind, access_ref_json,
          preview_ref_json, availability_status, provider_metadata_json, metadata_json, created_at, updated_at
        ) VALUES (?, ?, 'imessage', 'local', ?, 'file', 'text/plain', 'variant.txt', 'Variant', ?, NULL, ?, NULL, 'local_path', ?, NULL, 'available', '{}', '{}', ?, ?)
      `,
      )
      .run(
        "attachment-variant",
        "message-variant",
        "source-attachment-variant",
        sourcePath,
        19,
        JSON.stringify({ path: sourcePath }),
        timestamp,
        timestamp,
      );

    const fetched = await fetchAttachment(db, {
      attachmentId: "attachment-variant",
      variant: "preview",
    });

    if (fetched.localPath) {
      cleanupPaths.push(fetched.localPath);
    }
    expect(fetched.cache?.variant).toBe("preview");
    expect(fetched.cacheHit).toBe(false);

    const second = await fetchAttachment(db, {
      attachmentId: "attachment-variant",
      variant: "preview",
    });
    expect(second.cacheHit).toBe(true);
    expect(second.cache?.variant).toBe("preview");

    db.close();
  });

  it("expands home-relative access_ref paths when fetching local attachments", async () => {
    const db = createDb();
    const homeDir = mkdtempSync(join(tmpdir(), "cued-attachments-home-"));
    tempDirs.push(homeDir);
    process.env.HOME = homeDir;

    const attachmentDir = join(homeDir, "Library", "Messages", "Attachments");
    mkdirSync(attachmentDir, { recursive: true });
    const sourcePath = join(attachmentDir, "note.txt");
    writeFileSync(sourcePath, "attachment from tilde path\n");

    const timestamp = Date.now();
    const sql = sqlite(db);
    sql
      .prepare(
        `
        INSERT INTO conversations (
          id, platform, account_key, source_conversation_key, native_conversation_key, type, subtype,
          service, name, topic, participant_names, last_message_id, last_message_at, last_message_preview,
          unread_count, created_at, updated_at
        ) VALUES (?, 'imessage', 'local', ?, NULL, 'dm', NULL, 'iMessage', ?, NULL, '', NULL, NULL, NULL, 0, ?, ?)
      `,
      )
      .run("conversation-2", "source-conversation-2", "Thread", timestamp, timestamp);
    sql
      .prepare(
        `
        INSERT INTO messages (
          id, platform, account_key, platform_message_id, conversation_id, sender_contact_id,
          sender_source_key, sender_name, conversation_name, sent_at, service, status, is_from_me,
          content, delivered_at, read_at, edited_at, deleted_at, reply_to_message_id, is_deleted,
          is_edited, attachment_count, reaction_count, created_at, updated_at
        ) VALUES (?, 'imessage', 'local', ?, ?, NULL, NULL, 'Ben', 'Thread', ?, 'iMessage', 'delivered', 0, 'hello', NULL, NULL, NULL, NULL, NULL, 0, 0, 1, 0, ?, ?)
      `,
      )
      .run("message-2", "platform-message-2", "conversation-2", timestamp, timestamp, timestamp);
    sql
      .prepare(
        `
        INSERT INTO message_attachments (
          id, message_id, platform, account_key, source_attachment_key, kind, mime_type, filename,
          title, local_path, remote_url, size_bytes, text_content, access_kind, access_ref_json,
          preview_ref_json, availability_status, provider_metadata_json, metadata_json, created_at, updated_at
        ) VALUES (?, ?, 'imessage', 'local', ?, 'file', 'text/plain', 'note.txt', 'Note', ?, NULL, ?, NULL, 'local_path', ?, NULL, 'available', '{}', '{}', ?, ?)
      `,
      )
      .run(
        "attachment-2",
        "message-2",
        "source-attachment-2",
        "~/Library/Messages/Attachments/note.txt",
        27,
        JSON.stringify({ path: "~/Library/Messages/Attachments/note.txt" }),
        timestamp,
        timestamp,
      );

    const fetched = await fetchAttachment(db, {
      attachmentId: "attachment-2",
    });
    if (fetched.localPath) {
      cleanupPaths.push(fetched.localPath);
    }
    expect(fetched.localPath).toBeTruthy();
    expect(fetched.content).toEqual(
      expect.objectContaining({
        status: "ready",
        hasText: true,
      }),
    );

    db.close();
  });

  it("marks the cache entry as failed when payload acquisition throws", async () => {
    const db = createDb();
    const timestamp = Date.now();
    const sql = sqlite(db);
    sql
      .prepare(
        `
        INSERT INTO conversations (
          id, platform, account_key, source_conversation_key, native_conversation_key, type, subtype,
          service, name, topic, participant_names, last_message_id, last_message_at, last_message_preview,
          unread_count, created_at, updated_at
        ) VALUES (?, 'imessage', 'local', ?, NULL, 'dm', NULL, 'iMessage', ?, NULL, '', NULL, NULL, NULL, 0, ?, ?)
      `,
      )
      .run("conversation-3", "source-conversation-3", "Thread", timestamp, timestamp);
    sql
      .prepare(
        `
        INSERT INTO messages (
          id, platform, account_key, platform_message_id, conversation_id, sender_contact_id,
          sender_source_key, sender_name, conversation_name, sent_at, service, status, is_from_me,
          content, delivered_at, read_at, edited_at, deleted_at, reply_to_message_id, is_deleted,
          is_edited, attachment_count, reaction_count, created_at, updated_at
        ) VALUES (?, 'imessage', 'local', ?, ?, NULL, NULL, 'Ben', 'Thread', ?, 'iMessage', 'delivered', 0, 'hello', NULL, NULL, NULL, NULL, NULL, 0, 0, 1, 0, ?, ?)
      `,
      )
      .run("message-3", "platform-message-3", "conversation-3", timestamp, timestamp, timestamp);
    sql
      .prepare(
        `
        INSERT INTO message_attachments (
          id, message_id, platform, account_key, source_attachment_key, kind, mime_type, filename,
          title, local_path, remote_url, size_bytes, text_content, access_kind, access_ref_json,
          preview_ref_json, availability_status, provider_metadata_json, metadata_json, created_at, updated_at
        ) VALUES (?, ?, 'imessage', 'local', ?, 'file', 'text/plain', 'missing.txt', 'Missing', ?, NULL, ?, NULL, 'local_path', ?, NULL, 'available', '{}', '{}', ?, ?)
      `,
      )
      .run(
        "attachment-3",
        "message-3",
        "source-attachment-3",
        "/definitely/missing/path.txt",
        0,
        JSON.stringify({ path: "/definitely/missing/path.txt" }),
        timestamp,
        timestamp,
      );

    await expect(
      fetchAttachment(db, {
        attachmentId: "attachment-3",
      }),
    ).rejects.toThrow("Attachment source path does not exist");

    const cacheEntry = db.getAttachmentCacheEntry("attachment-3", "original");
    expect(cacheEntry).toEqual(
      expect.objectContaining({
        status: "failed",
      }),
    );
    expect(cacheEntry?.last_error).toContain("Attachment source path does not exist");

    db.close();
  });

  it("keeps a shared cached object on disk while another ready entry still references it", async () => {
    const db = createDb();
    const fileDir = mkdtempSync(join(tmpdir(), "cued-attachments-shared-"));
    tempDirs.push(fileDir);
    const sourcePath = join(fileDir, "shared.txt");
    writeFileSync(sourcePath, "shared cache payload\n");

    const timestamp = Date.now();
    const sql = sqlite(db);
    sql
      .prepare(
        `
        INSERT INTO conversations (
          id, platform, account_key, source_conversation_key, native_conversation_key, type, subtype,
          service, name, topic, participant_names, last_message_id, last_message_at, last_message_preview,
          unread_count, created_at, updated_at
        ) VALUES (?, 'imessage', 'local', ?, NULL, 'dm', NULL, 'iMessage', ?, NULL, '', NULL, NULL, NULL, 0, ?, ?)
      `,
      )
      .run("conversation-shared", "source-conversation-shared", "Thread", timestamp, timestamp);

    for (const suffix of ["a", "b"]) {
      sql
        .prepare(
          `
          INSERT INTO messages (
            id, platform, account_key, platform_message_id, conversation_id, sender_contact_id,
            sender_source_key, sender_name, conversation_name, sent_at, service, status, is_from_me,
            content, delivered_at, read_at, edited_at, deleted_at, reply_to_message_id, is_deleted,
            is_edited, attachment_count, reaction_count, created_at, updated_at
          ) VALUES (?, 'imessage', 'local', ?, ?, NULL, NULL, 'Ben', 'Thread', ?, 'iMessage', 'delivered', 0, 'hello', NULL, NULL, NULL, NULL, NULL, 0, 0, 1, 0, ?, ?)
        `,
        )
        .run(
          `message-shared-${suffix}`,
          `platform-message-shared-${suffix}`,
          "conversation-shared",
          timestamp,
          timestamp,
          timestamp,
        );
      sql
        .prepare(
          `
          INSERT INTO message_attachments (
            id, message_id, platform, account_key, source_attachment_key, kind, mime_type, filename,
            title, local_path, remote_url, size_bytes, text_content, access_kind, access_ref_json,
            preview_ref_json, availability_status, provider_metadata_json, metadata_json, created_at, updated_at
          ) VALUES (?, ?, 'imessage', 'local', ?, 'file', 'text/plain', 'shared.txt', 'Shared', ?, NULL, ?, NULL, 'local_path', ?, NULL, 'available', '{}', '{}', ?, ?)
        `,
        )
        .run(
          `attachment-shared-${suffix}`,
          `message-shared-${suffix}`,
          `source-attachment-shared-${suffix}`,
          sourcePath,
          21,
          JSON.stringify({ path: sourcePath }),
          timestamp,
          timestamp,
        );
    }

    const first = await fetchAttachment(db, {
      attachmentId: "attachment-shared-a",
      cacheLimitBytes: 30,
    });
    const second = await fetchAttachment(db, {
      attachmentId: "attachment-shared-b",
      cacheLimitBytes: 30,
    });

    expect(first.localPath).toBeTruthy();
    expect(second.localPath).toBeTruthy();
    expect(first.localPath).toBe(second.localPath);

    const firstCache = db.getAttachmentCacheEntry("attachment-shared-a", "original");
    const secondCache = db.getAttachmentCacheEntry("attachment-shared-b", "original");

    expect(firstCache?.status).toBe("evicted");
    expect(secondCache?.status).toBe("ready");
    expect(secondCache?.cache_path).toBeTruthy();
    expect(secondCache?.cache_path).toBe(first.localPath);
    if (secondCache?.cache_path) {
      cleanupPaths.push(secondCache.cache_path);
      expect(existsSync(secondCache.cache_path)).toBe(true);
    }

    db.close();
  });
});
