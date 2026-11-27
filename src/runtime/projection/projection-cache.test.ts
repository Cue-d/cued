import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { CuedDatabase } from "../../db/database.js";
import {
  createProjectionCacheOverlay,
  ReadThroughLookup,
  type StoredProjectionCache,
} from "./projection-cache.js";
import { projectPendingRawEvents } from "./projector.js";

function emptyCache(): StoredProjectionCache {
  return {
    contactMergeAliasMap: new Map(),
    sourceContactMap: new Map(),
    deterministicHandleMap: new Map(),
    conversationMap: new Map(),
    contactNameMap: new Map(),
    conversationNameMap: new Map(),
  };
}

describe("read-through projection cache", () => {
  it("reads each key once, keeps writes, and drops only what it read", () => {
    const rows = new Map([["known", "from database"]]);
    let reads = 0;
    const lookup = new ReadThroughLookup<string>((key) => {
      reads += 1;
      return rows.get(key);
    });
    expect(lookup.get("known")).toBe("from database");
    expect(lookup.has("missing")).toBe(false);
    expect(lookup.get("known")).toBe("from database");
    expect(lookup.get("missing")).toBeUndefined();
    expect(reads).toBe(2);
    lookup.set("written", "by projector");
    rows.set("missing", "added later");
    lookup.forgetLoaded();
    expect(lookup.get("missing")).toBe("added later");
    expect(lookup.get("written")).toBe("by projector");
    expect(reads).toBe(3);
  });

  it("finds rows written before the process started, including keys with colons", () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-cache-lookup-"));
    const dbPath = join(dir, "local.db");
    const seed = new CuedDatabase(dbPath);
    try {
      seed.migrate();
      seed.orm().run(sql`INSERT INTO contacts (id, kind, name, archived, created_at, updated_at)
        VALUES ('existing-contact', 'person', 'Existing Person', 0, 1, 1),
               ('merged-contact', 'person', 'Merged Person', 0, 1, 1)`);
      seed.orm().run(sql`INSERT INTO contact_sources (id, contact_id, platform, account_key,
          source_entity_key, first_seen_at, last_seen_at)
        VALUES ('existing-source', 'merged-contact', 'slack', 'T1:U1', 'U2:sender', 1, 1)`);
      seed.orm().run(sql`INSERT INTO contact_merge_decisions (id, decision_type,
          primary_contact_id, secondary_contact_id, canonical_contact_id, created_at)
        VALUES ('merge', 'merge', 'existing-contact', 'merged-contact', 'existing-contact', 1)`);
      seed.orm().run(sql`INSERT INTO conversations (id, platform, account_key,
          source_conversation_key, type, is_active, name, unread_count, created_at, updated_at)
        VALUES ('existing-conversation', 'slack', 'T1:U1', 'C1:thread', 'group', 1,
          'Existing Channel', 0, 1, 1)`);
    } finally {
      seed.close();
    }
    const db = new CuedDatabase(dbPath);
    try {
      db.insertRawEvent({
        id: "message",
        platform: "slack",
        accountKey: "T1:U1",
        entityKind: "message",
        eventKind: "created",
        observedAt: 1_710_000_000_000,
        dedupeKey: "message",
        payload: {
          sourceMessageKey: "message",
          sourceConversationKey: "C1:thread",
          senderSourceKey: "U2:sender",
          sentAt: 1_710_000_000_000,
          content: "Hello",
          service: "slack",
          isFromMe: false,
        },
      });
      expect(projectPendingRawEvents(db).appliedRawEvents).toBe(1);
      expect(
        db.orm().all(sql`SELECT conversation_id, sender_contact_id, sender_name, conversation_name
          FROM messages`),
      ).toEqual([
        {
          conversation_id: "existing-conversation",
          sender_contact_id: "existing-contact",
          sender_name: "Existing Person",
          conversation_name: "Existing Channel",
        },
      ]);
      expect(db.orm().all(sql`SELECT COUNT(*) AS count FROM conversations`)).toEqual([
        { count: 1 },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("projection cache transaction overlays", () => {
  it("isolates all maps until commit and preserves explicit null names", () => {
    const base = emptyCache();
    base.contactNameMap.set("contact", "Before");
    const batch = createProjectionCacheOverlay(base);
    const event = createProjectionCacheOverlay(batch.cache);
    for (const map of Object.values(event.cache)) map.set("key", "value");
    event.cache.contactNameMap.set("contact", null);
    expect(event.cache.contactNameMap.get("contact")).toBeNull();
    expect(batch.cache.contactNameMap.get("contact")).toBe("Before");
    event.commit();
    expect(batch.cache.contactNameMap.get("contact")).toBeNull();
    expect(base.contactNameMap.get("contact")).toBe("Before");
    const failed = createProjectionCacheOverlay(batch.cache);
    failed.cache.contactNameMap.set("contact", "Rolled back");
    batch.commit();
    expect(base.contactNameMap.get("contact")).toBeNull();
    for (const map of Object.values(base)) {
      expect(map.get("key")).toBe("value");
    }
  });

  it("discards savepoint and whole-transaction changes before retrying projection", () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-cache-rollback-"));
    const db = new CuedDatabase(join(dir, "local.db"));
    try {
      db.migrate();
      const contactEvent = (id: string, name: string) => ({
        id,
        platform: "contacts" as const,
        accountKey: "local",
        entityKind: "contact" as const,
        eventKind: "observed",
        observedAt: 1_710_000_000_000,
        dedupeKey: id,
        payload: {
          sourceEntityKey: id,
          fields: { display_name: name },
          handles: [{ type: "email" as const, value: "same@example.com", deterministic: true }],
        },
      });
      db.insertRawEvent(contactEvent("first", "Original"));
      projectPendingRawEvents(db);
      db.orm().run(sql`CREATE TRIGGER reject_bad_source BEFORE INSERT ON contact_sources
        WHEN NEW.source_entity_key = 'bad'
        BEGIN SELECT RAISE(ABORT, 'forced event failure'); END`);
      db.insertRawEvent(contactEvent("bad", "Rejected"));
      db.insertRawEvent(contactEvent("good", "Accepted"));
      expect(projectPendingRawEvents(db).appliedRawEvents).toBe(1);
      expect(db.orm().all(sql`SELECT name FROM contacts`)).toEqual([{ name: "Accepted" }]);
      expect(
        db.orm().all(sql`SELECT source_entity_key FROM contact_sources ORDER BY source_entity_key`),
      ).toEqual([{ source_entity_key: "first" }, { source_entity_key: "good" }]);
      expect(db.orm().all(sql`SELECT raw_event_id FROM raw_event_projection_failures`)).toEqual([
        { raw_event_id: "bad" },
      ]);

      db.orm().run(sql`CREATE TRIGGER reject_projection_commit BEFORE UPDATE ON projection_state
        BEGIN SELECT RAISE(ABORT, 'forced batch failure'); END`);
      db.insertRawEvent(contactEvent("retry", "Retry"));
      expect(() => projectPendingRawEvents(db)).toThrow("forced batch failure");
      expect(db.orm().all(sql`SELECT name FROM contacts`)).toEqual([{ name: "Accepted" }]);
      db.orm().run(sql`DROP TRIGGER reject_projection_commit`);
      expect(projectPendingRawEvents(db).appliedRawEvents).toBe(1);
      expect(db.orm().all(sql`SELECT name FROM contacts`)).toEqual([{ name: "Retry" }]);
      expect(db.orm().all(sql`SELECT COUNT(*) AS count FROM contacts`)).toEqual([{ count: 1 }]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
