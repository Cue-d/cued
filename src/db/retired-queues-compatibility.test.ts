import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectPendingRawEvents } from "../runtime/projection/projector.js";
import { CuedDatabase } from "./database.js";
import { MIGRATIONS } from "./migrations.js";
import { openSqliteDatabase } from "./sqlite.js";

describe("retired queue database compatibility", () => {
  it.each([
    "0014_jobs_table",
    "current",
  ])("preserves legacy rows and indexes with migration ledger through %s", (lastRecordedMigration) => {
    const dir = mkdtempSync(join(tmpdir(), "cued-retired-queues-"));
    const path = join(dir, "local.db");
    let db: CuedDatabase | undefined;
    const legacy = openSqliteDatabase(path);
    try {
      // Use the current canonical bootstrap with either a partial or complete
      // migration ledger. The partial ledger exercises subsequent migrations
      // against legacy queue rows; it is not a frozen historical schema.
      for (const migration of MIGRATIONS) {
        legacy.transaction(() => {
          if (migration.apply) migration.apply(legacy);
          else if (migration.sql) legacy.exec(migration.sql);
          legacy
            .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
            .run(migration.id, 1);
        })();
        if (migration.id === lastRecordedMigration) break;
      }

      const insertJob = legacy.prepare(`
          INSERT INTO jobs (
            id, kind, platform, account_key, priority, status, trigger, queued_at,
            scheduled_at, started_at, finished_at, attempt, owner_id,
            lease_expires_at, last_progress_at, checkpoint_json, progress_json, error_json
          ) VALUES (?, 'ingest', 'signal', 'default', 30, ?, 'legacy', 1, 2, 3,
            4, 2, 'old-worker', 5, 6, '{"cursor":"old"}', '{"count":9}', '{"message":"old failure"}')
        `);
      for (const status of ["queued", "running", "retry_wait", "completed", "failed", "canceled"]) {
        insertJob.run(`legacy-job-${status}`, status);
      }
      const insertOutbound = legacy.prepare(`
          INSERT INTO outbound_messages (
            id, platform, account_key, target, thread_id, text, status, attempt_count,
            scheduled_for, started_at, finished_at, last_error, metadata_json, created_at, updated_at
          ) VALUES (?, 'signal', 'default', '+14155550123', 'dm:+14155550123',
            'Keep this archived draft', ?, 2, 1, 2, 3, 'old failure', '{"legacy":true}', 4, 5)
        `);
      for (const status of ["pending", "sending", "sent", "failed"]) {
        insertOutbound.run(`legacy-outbound-${status}`, status);
      }

      const jobs = legacy.prepare("SELECT * FROM jobs ORDER BY id").all();
      const outbound = legacy.prepare("SELECT * FROM outbound_messages ORDER BY id").all();
      const schemaQuery = `SELECT type, name, tbl_name, sql FROM sqlite_master
          WHERE tbl_name IN ('jobs', 'outbound_messages') ORDER BY type, name`;
      const queueSchema = legacy.prepare(schemaQuery).all();
      const ledger = legacy.prepare("SELECT * FROM schema_migrations ORDER BY id").all();
      if (lastRecordedMigration !== "current") {
        expect(ledger).toContainEqual({ id: lastRecordedMigration, applied_at: 1 });
        expect(ledger.length).toBeLessThan(MIGRATIONS.length);
      }
      expect(legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all()).toEqual(
        expect.arrayContaining([
          { name: "idx_jobs_claim" },
          { name: "idx_jobs_owner_lease" },
          { name: "idx_jobs_platform_account_status" },
          { name: "idx_outbound_messages_status_scheduled" },
          { name: "idx_outbound_messages_platform_account_status" },
        ]),
      );
      legacy.close();

      db = new CuedDatabase(path);
      db.migrate();
      const verifyPreserved = (current: CuedDatabase) => {
        expect(current.executeReadOnlySql("SELECT * FROM jobs ORDER BY id")).toEqual(jobs);
        expect(current.executeReadOnlySql("SELECT * FROM outbound_messages ORDER BY id")).toEqual(
          outbound,
        );
        expect(current.executeReadOnlySql(schemaQuery)).toEqual(queueSchema);
        expect(current.executeReadOnlySql("SELECT * FROM schema_migrations ORDER BY id")).toEqual(
          expect.arrayContaining(ledger),
        );
        expect(current.executeReadOnlySql("PRAGMA integrity_check")).toEqual([
          { integrity_check: "ok" },
        ]);
      };
      verifyPreserved(db);

      const runId = db.queueSyncRun({
        platform: "signal",
        accountKey: "default",
        runType: "sync",
        trigger: "manual",
      });
      expect(db.claimNextQueuedRun()).toMatchObject({ id: runId, status: "ingesting" });
      db.insertRawEvent({
        id: "synced-sent-message",
        platform: "signal",
        accountKey: "default",
        entityKind: "message",
        eventKind: "created",
        observedAt: 100,
        dedupeKey: "signal:synced-sent-message",
        sourceVersion: "signal-v1",
        payload: {
          sourceMessageKey: "sent-elsewhere",
          sourceConversationKey: "dm:+14155550123",
          senderSourceKey: "self",
          sentAt: 100,
          content: "Sent from the provider app",
          service: "signal",
          isFromMe: true,
          status: "sent",
        },
      });
      expect(projectPendingRawEvents(db)).toMatchObject({ appliedRawEvents: 1, messages: 1 });
      db.drainMessageFtsIndexQueue(10);
      expect(db.executeReadOnlySql("SELECT content, is_from_me FROM messages")).toEqual([
        { content: "Sent from the provider app", is_from_me: 1 },
      ]);
      expect(
        db.executeReadOnlySql(
          "SELECT content FROM messages_fts WHERE messages_fts MATCH 'provider'",
        ),
      ).toEqual([{ content: "Sent from the provider app" }]);
      expect(db.finishRun(runId)).toBe(true);
      expect(db.listRecentRuns(1)[0]).toMatchObject({ id: runId, status: "completed" });
      verifyPreserved(db);

      db.close();
      db = new CuedDatabase(path);
      db.migrate();
      verifyPreserved(db);
      expect(db.getOverview()).toMatchObject({ messages: 1, rawEvents: 1 });
    } finally {
      db?.close();
      if (legacy.open) legacy.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
