import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CuedDatabase, openCuedDatabase } from "../../db/database.js";
import { openSqliteDatabase } from "../../db/sqlite.js";
import {
  BusyRetryingTimerJob,
  SQLITE_BUSY_SKIPPED,
  withoutWaitingForWriteLock,
} from "./write-lock.js";

describe("withoutWaitingForWriteLock", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      cleanup();
    }
  });

  function openPair(): { db: CuedDatabase; other: ReturnType<typeof openSqliteDatabase> } {
    const dir = mkdtempSync(join(tmpdir(), "cued-write-lock-"));
    const dbPath = join(dir, "local.db");
    const db = openCuedDatabase(dbPath);
    const other = openSqliteDatabase(dbPath);
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    cleanups.push(() => db.close());
    cleanups.push(() => other.close());
    return { db, other };
  }

  const heartbeat = (db: CuedDatabase, updatedAt: number) =>
    db.upsertDaemonState({
      pid: 1,
      startedAt: 1,
      updatedAt,
      status: "running",
      version: "test",
    });

  it("skips at once instead of waiting while another connection holds the write lock", () => {
    const { db, other } = openPair();
    other.exec("BEGIN IMMEDIATE");
    try {
      const startedAt = performance.now();
      const outcome = withoutWaitingForWriteLock(db, () => heartbeat(db, 2));
      const elapsedMs = performance.now() - startedAt;
      expect(outcome).toBe(SQLITE_BUSY_SKIPPED);
      // The daemon's stall target is 50 ms; the default busy timeout would wait 5 s here.
      expect(elapsedMs).toBeLessThan(50);
    } finally {
      other.exec("COMMIT");
    }

    // Once the lock is free the same work lands.
    expect(withoutWaitingForWriteLock(db, () => heartbeat(db, 3))).toBeUndefined();
    expect(db.getDaemonState()?.updated_at).toBe(3);
  });

  it("rethrows other errors and leaves the normal busy timeout in place", () => {
    const { db, other } = openPair();
    const busyTimeout = () =>
      (db.orm().get(sql`PRAGMA busy_timeout`) as Record<string, number> | undefined) ?? {};
    const normal = busyTimeout();
    other.exec("BEGIN IMMEDIATE");
    expect(withoutWaitingForWriteLock(db, () => heartbeat(db, 2))).toBe(SQLITE_BUSY_SKIPPED);
    other.exec("COMMIT");
    expect(() =>
      withoutWaitingForWriteLock(db, () => {
        throw new Error("not a lock problem");
      }),
    ).toThrow("not a lock problem");
    expect(busyTimeout()).toEqual(normal);
    expect(Object.values(normal)[0]).toBeGreaterThan(0);
  });
});

describe("BusyRetryingTimerJob", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries soon after a busy skip, then returns to its interval", () => {
    vi.useFakeTimers();
    const outcomes: unknown[] = [SQLITE_BUSY_SKIPPED, SQLITE_BUSY_SKIPPED, undefined, undefined];
    const runs: number[] = [];
    const onBusy = vi.fn();
    const onRecovered = vi.fn();
    const job = new BusyRetryingTimerJob({
      intervalMs: 60_000,
      busyRetryMs: 1_000,
      run: () => {
        runs.push(Date.now());
        return outcomes.shift();
      },
      onBusy,
      onRecovered,
    });
    const startedAt = Date.now();
    job.start();

    vi.advanceTimersByTime(59_999);
    expect(runs).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(runs).toHaveLength(1);
    expect(onBusy).toHaveBeenCalledTimes(1);

    // Two busy skips, each retried a second later; the third attempt lands.
    vi.advanceTimersByTime(2_000);
    expect(runs.map((at) => at - startedAt)).toEqual([60_000, 61_000, 62_000]);
    expect(onBusy).toHaveBeenCalledTimes(1);
    expect(onRecovered).toHaveBeenCalledWith(2);

    // Back on the regular interval from the run that landed.
    vi.advanceTimersByTime(59_999);
    expect(runs).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(runs.map((at) => at - startedAt)).toEqual([60_000, 61_000, 62_000, 122_000]);

    job.stop();
    vi.advanceTimersByTime(600_000);
    expect(runs).toHaveLength(4);
  });

  it("keeps its schedule when a run throws", () => {
    vi.useFakeTimers();
    let runs = 0;
    const job = new BusyRetryingTimerJob({
      intervalMs: 60_000,
      busyRetryMs: 1_000,
      run: () => {
        runs += 1;
        if (runs === 1) {
          throw new Error("disk full");
        }
      },
    });
    job.start();

    expect(() => vi.advanceTimersByTime(60_000)).toThrow("disk full");
    vi.advanceTimersByTime(60_000);
    expect(runs).toBe(2);

    job.stop();
  });
});
