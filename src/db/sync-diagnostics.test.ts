import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { CuedDatabase } from "./database.js";

it("indexes latest completed sync diagnostics without changing account or run filtering", () => {
  const dir = mkdtempSync(join(tmpdir(), "cued-sync-diagnostics-"));
  const db = new CuedDatabase(join(dir, "local.db"));
  try {
    db.migrate();
    // Exercise an upgrade with existing history, not only fresh schema creation.
    db.orm().run(sql`DROP INDEX idx_sync_runs_platform_account_finished`);
    db.orm().run(
      sql`DELETE FROM schema_migrations WHERE id = '0022_latest_finished_sync_run_index'`,
    );
    const rows = [
      { platform: "slack", account: "one", type: "sync", status: "completed", at: 100 },
      { platform: "slack", account: "one", type: "sync_resume", status: "failed", at: 200 },
      { platform: "slack", account: "two", type: "sync", status: "completed", at: 900 },
      { platform: "gmail", account: "one", type: "sync", status: "completed", at: 1000 },
      { platform: "slack", account: "one", type: "project", status: "completed", at: 300 },
      { platform: "slack", account: "one", type: "sync", status: "queued", at: 400 },
      { platform: "slack", account: "one", type: "sync", status: "completed", at: null },
    ];
    for (const [i, row] of rows.entries()) {
      db.orm().run(sql`INSERT INTO sync_runs
        (id, platform, account_key, run_type, status, trigger, queued_at, scheduled_at, attempt, finished_at)
        VALUES (${`run-${i}`}, ${row.platform}, ${row.account}, ${row.type}, ${row.status},
          'test', 1, 1, 0, ${row.at})`);
    }
    const expected = { status: "failed", finished_at: 200, details_json: null };
    expect(db.getLatestFinishedSyncRun("slack", "one")).toEqual(expected);
    db.migrate();
    db.migrate();
    expect(db.getLatestFinishedSyncRun("slack", "one")).toEqual(expected);
    expect(db.getLatestFinishedSyncRun("slack", "absent")).toBeNull();
    const plan = db.orm().all<{ detail: string }>(sql`EXPLAIN QUERY PLAN
      SELECT status, finished_at, details_json FROM sync_runs
      WHERE platform = ${"slack"} AND account_key = ${"one"}
        AND run_type IN (${"sync"}, ${"sync_resume"})
        AND status IN (${"completed"}, ${"failed"}) AND finished_at IS NOT NULL
      ORDER BY finished_at DESC LIMIT 1`);
    const details = plan.map((row) => row.detail).join("\n");
    expect(details).toContain("idx_sync_runs_platform_account_finished");
    expect(details).not.toContain("USE TEMP B-TREE");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
