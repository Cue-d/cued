import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "./database.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

describe("sync run history", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createDb(): CuedDatabase {
    const dir = mkdtempSync(join(tmpdir(), "cued-sync-run-history-"));
    dirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
    return db;
  }

  function insertRun(
    db: CuedDatabase,
    run: {
      id: string;
      platform?: string;
      account?: string;
      status: string;
      ageDays: number;
      withError?: boolean;
    },
  ): void {
    const queuedAt = NOW - run.ageDays * DAY_MS;
    const finished = run.status === "completed" || run.status === "failed";
    db.orm().run(sql`INSERT INTO sync_runs
      (id, platform, account_key, run_type, status, trigger, queued_at, scheduled_at, attempt, finished_at)
      VALUES (${run.id}, ${run.platform ?? "slack"}, ${run.account ?? "T1"}, 'sync', ${run.status},
        'test', ${queuedAt}, ${queuedAt}, 1, ${finished ? queuedAt + 1_000 : null})`);
    if (run.withError) {
      db.orm().run(sql`INSERT INTO sync_run_errors
        (id, sync_run_id, platform, account_key, error_message, created_at)
        VALUES (${`error-${run.id}`}, ${run.id}, ${run.platform ?? "slack"}, ${run.account ?? "T1"},
          'boom', ${queuedAt})`);
    }
  }

  function runIds(db: CuedDatabase): string[] {
    return db
      .orm()
      .all<{ id: string }>(sql`SELECT id FROM sync_runs ORDER BY id`)
      .map((row) => row.id);
  }

  function errorRunIds(db: CuedDatabase): string[] {
    return db
      .orm()
      .all<{ id: string }>(sql`SELECT sync_run_id AS id FROM sync_run_errors ORDER BY id`)
      .map((row) => row.id);
  }

  function registerAccount(db: CuedDatabase, platform: "slack" | "gmail", accountKey: string) {
    db.upsertIntegrationState({
      platform,
      accountKey,
      authState: "authenticated",
      connectionKind: "browser-session",
    });
  }

  it("looks up a run's errors by index, so deleting a run never scans the errors table", () => {
    const db = createDb();
    try {
      const plan = db
        .orm()
        .all<{ detail: string }>(
          sql`EXPLAIN QUERY PLAN SELECT 1 FROM sync_run_errors WHERE sync_run_id = 'x'`,
        )
        .map((row) => row.detail)
        .join("\n");
      expect(plan).toContain("idx_sync_run_errors_sync_run_id");
      expect(plan).not.toMatch(/\bSCAN sync_run_errors\b/);
    } finally {
      db.close();
    }
  });

  it("adds the errors index to a database that predates it", () => {
    const db = createDb();
    try {
      db.orm().run(sql`DROP INDEX idx_sync_run_errors_sync_run_id`);
      db.orm().run(sql`DELETE FROM schema_migrations WHERE id = '0026_sync_run_errors_run_index'`);
      db.migrate();
      const indexes = db
        .orm()
        .all<{ name: string }>(sql`PRAGMA index_list(sync_run_errors)`)
        .map((row) => row.name);
      expect(indexes).toContain("idx_sync_run_errors_sync_run_id");
    } finally {
      db.close();
    }
  });

  it("prunes aged-out runs but keeps recent ones, active ones and each account's latest", () => {
    const db = createDb();
    try {
      registerAccount(db, "slack", "T1");
      registerAccount(db, "gmail", "idle@example.com");
      insertRun(db, { id: "old-completed", status: "completed", ageDays: 10 });
      insertRun(db, { id: "old-failed-in-window", status: "failed", ageDays: 10, withError: true });
      insertRun(db, { id: "ancient-failed", status: "failed", ageDays: 30, withError: true });
      insertRun(db, { id: "recent-completed", status: "completed", ageDays: 1 });
      insertRun(db, { id: "old-queued", status: "queued", ageDays: 10 });
      // The only run this account has: old, but still what status reports as its last sync.
      insertRun(db, {
        id: "idle-latest",
        platform: "gmail",
        account: "idle@example.com",
        status: "completed",
        ageDays: 90,
      });

      expect(db.pruneSyncRunHistory({ limit: 100, nowMs: NOW })).toBe(2);
      expect(runIds(db)).toEqual([
        "idle-latest",
        "old-failed-in-window",
        "old-queued",
        "recent-completed",
      ]);
      // Errors go with their run, and only with their run.
      expect(errorRunIds(db)).toEqual(["old-failed-in-window"]);
      expect(db.pruneSyncRunHistory({ limit: 100, nowMs: NOW })).toBe(0);
    } finally {
      db.close();
    }
  });

  it("prunes in bounded batches, oldest first", () => {
    const db = createDb();
    try {
      registerAccount(db, "slack", "T1");
      for (let index = 0; index < 5; index += 1) {
        insertRun(db, { id: `run-${index}`, status: "completed", ageDays: 20 - index });
      }
      insertRun(db, { id: "run-latest", status: "completed", ageDays: 0 });

      expect(db.pruneSyncRunHistory({ limit: 2, nowMs: NOW })).toBe(2);
      expect(runIds(db)).toEqual(["run-2", "run-3", "run-4", "run-latest"]);
      expect(db.pruneSyncRunHistory({ limit: 2, nowMs: NOW })).toBe(2);
      expect(db.pruneSyncRunHistory({ limit: 2, nowMs: NOW })).toBe(1);
      expect(runIds(db)).toEqual(["run-latest"]);
    } finally {
      db.close();
    }
  });

  it("walks the queued_at index instead of sorting every finished run", () => {
    const db = createDb();
    try {
      const plan = db
        .orm()
        .all<{ detail: string }>(sql`EXPLAIN QUERY PLAN
          SELECT rowid FROM sync_runs
          WHERE queued_at < 1
            AND CASE status WHEN 'completed' THEN queued_at < 1 WHEN 'failed' THEN queued_at < 1 ELSE 0 END
            AND id NOT IN (SELECT value FROM json_each('[]'))
          ORDER BY queued_at ASC LIMIT 10`)
        .map((row) => row.detail)
        .join("\n");
      expect(plan).toContain("idx_sync_runs_queued_at");
      expect(plan).not.toContain("TEMP B-TREE");
    } finally {
      db.close();
    }
  });

  it("purges one account's finished history in batches, bounded by time", () => {
    const db = createDb();
    try {
      insertRun(db, { id: "a-1", status: "completed", ageDays: 3, withError: true });
      insertRun(db, { id: "a-2", status: "failed", ageDays: 2 });
      insertRun(db, { id: "a-3", status: "completed", ageDays: 1 });
      insertRun(db, { id: "a-new", status: "completed", ageDays: -1 });
      insertRun(db, { id: "b-1", account: "T2", status: "completed", ageDays: 3 });
      const purge = { platform: "slack" as const, accountKey: "T1", queuedBefore: NOW };

      expect(db.deleteSyncRunHistoryBatch({ ...purge, limit: 2 })).toBe(2);
      expect(db.deleteSyncRunHistoryBatch({ ...purge, limit: 2 })).toBe(1);
      expect(db.deleteSyncRunHistoryBatch({ ...purge, limit: 2 })).toBe(0);
      // Runs queued after the cutoff (the account was re-added) and other accounts survive.
      expect(runIds(db)).toEqual(["a-new", "b-1"]);
      expect(errorRunIds(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("can leave finished history for a background purge when clearing an account", () => {
    const db = createDb();
    try {
      insertRun(db, { id: "finished", status: "completed", ageDays: 1, withError: true });
      insertRun(db, { id: "queued", status: "queued", ageDays: 0 });
      insertRun(db, { id: "ingesting", status: "ingesting", ageDays: 0 });

      db.clearIntegrationRuntimeState("slack", "T1", { deferSyncRunHistory: true });
      // Work that could still run for the removed account goes now; history waits.
      expect(runIds(db)).toEqual(["finished"]);
      expect(errorRunIds(db)).toEqual(["finished"]);

      db.clearIntegrationRuntimeState("slack", "T1");
      expect(runIds(db)).toEqual([]);
      expect(errorRunIds(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
