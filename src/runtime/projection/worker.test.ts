import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("projection worker", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createTempHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "cued-projection-worker-"));
    tempDirs.push(dir);
    return dir;
  }

  it("fails instead of reporting success when the run claim was reclaimed", async () => {
    const home = createTempHome();
    vi.stubEnv("CUED_HOME", home);
    vi.stubEnv("CUED_DB_PATH", join(home, "local.db"));
    vi.stubEnv("CUED_PROJECTION_BATCH_SIZE", "10");
    vi.resetModules();

    const { openCuedDatabase } = await import("../../db/database.js");
    const { runProjectionWorker } = await import("./worker.js");
    const db = openCuedDatabase();
    const runId = db.queueSyncRun({
      runType: "project",
      trigger: "test",
    });
    const staleRun = db.claimNextQueuedRun(["project"], "projecting", {
      ownerId: "daemon-a",
      leaseMs: 10_000,
    });
    expect(staleRun).toEqual(expect.objectContaining({ id: runId, attempt: 1 }));

    db.orm().run(sql`UPDATE sync_runs SET lease_expires_at = 1 WHERE id = ${runId}`);
    const currentRun = db.claimNextQueuedRun(["project"], "projecting", {
      ownerId: "daemon-b",
      leaseMs: 10_000,
    });
    expect(currentRun).toEqual(expect.objectContaining({ id: runId, attempt: 2 }));
    db.close();

    await expect(runProjectionWorker(staleRun!)).rejects.toThrow(
      `Projection run ${runId} lost ownership before completion`,
    );

    const verifyDb = openCuedDatabase();
    expect(
      verifyDb
        .executeReadOnlySql(`SELECT status, attempt, owner_id FROM sync_runs WHERE id = '${runId}'`)
        .at(0),
    ).toEqual({ status: "projecting", attempt: 2, owner_id: "daemon-b" });
    verifyDb.close();
  });
});
