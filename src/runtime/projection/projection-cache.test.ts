import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { CuedDatabase } from "../../db/database.js";
import { createProjectionCacheOverlay, type StoredProjectionCache } from "./projection-cache.js";
import { projectPendingRawEvents } from "./projector.js";

function emptyCache(): StoredProjectionCache {
  return {
    initialized: true,
    contactMergeAliasMap: new Map(),
    sourceContactMap: new Map(),
    deterministicHandleMap: new Map(),
    conversationMap: new Map(),
    contactNameMap: new Map(),
    conversationNameMap: new Map(),
  };
}

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
    for (const [name, map] of Object.entries(base)) {
      if (name !== "initialized") expect((map as Map<string, string>).get("key")).toBe("value");
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
