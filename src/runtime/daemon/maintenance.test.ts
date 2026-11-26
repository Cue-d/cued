import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncRunMaintenance } from "./maintenance.js";

type Call = { job: string; args: Record<string, unknown> };

function createWorker(results: Array<{ deleted: number; more: boolean } | Error>) {
  const calls: Call[] = [];
  return {
    calls,
    run: vi.fn(async (job: string, args: Record<string, unknown>) => {
      calls.push({ job, args });
      const result = results.shift() ?? { deleted: 0, more: false };
      if (result instanceof Error) {
        throw result;
      }
      return result;
    }) as never,
  };
}

describe("sync run maintenance", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps pruning in rounds until the worker reports nothing left", async () => {
    vi.useFakeTimers();
    const worker = createWorker([
      { deleted: 200, more: true },
      { deleted: 200, more: true },
      { deleted: 40, more: false },
    ]);
    const pruned: Array<{ deletedRuns: number }> = [];
    const maintenance = new SyncRunMaintenance(worker, {
      startDelayMs: 0,
      roundGapMs: 10,
      onPruned: (summary) => pruned.push(summary),
    });
    maintenance.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(worker.calls.map((call) => call.job)).toEqual([
      "pruneSyncRunHistory",
      "pruneSyncRunHistory",
      "pruneSyncRunHistory",
    ]);
    expect(pruned).toEqual([expect.objectContaining({ deletedRuns: 440 })]);
    maintenance.stop();
  });

  it("does not prune again until the retention interval has passed", async () => {
    vi.useFakeTimers();
    const worker = createWorker([]);
    const maintenance = new SyncRunMaintenance(worker, {
      startDelayMs: 0,
      retentionIntervalMs: 1_000,
    });
    maintenance.start();
    await vi.advanceTimersByTimeAsync(900);
    expect(worker.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(worker.calls).toHaveLength(2);
    maintenance.stop();
  });

  it("purges a removed account's history ahead of routine retention", async () => {
    vi.useFakeTimers();
    const worker = createWorker([
      { deleted: 200, more: true },
      { deleted: 10, more: false },
    ]);
    const maintenance = new SyncRunMaintenance(worker, { startDelayMs: 60_000, roundGapMs: 10 });
    maintenance.start();
    maintenance.purgeAccountHistory("slack", "T1", 123);
    await vi.advanceTimersByTimeAsync(50);

    expect(worker.calls.slice(0, 2)).toEqual([
      {
        job: "purgeAccountSyncRunHistory",
        args: expect.objectContaining({ platform: "slack", accountKey: "T1", queuedBefore: 123 }),
      },
      { job: "purgeAccountSyncRunHistory", args: expect.anything() },
    ]);
    // With the purge done, retention gets its turn.
    expect(worker.calls[2]?.job).toBe("pruneSyncRunHistory");
    maintenance.stop();
  });

  it("stands aside while a sync or projection is running", async () => {
    vi.useFakeTimers();
    const worker = createWorker([]);
    let busy = true;
    const maintenance = new SyncRunMaintenance(worker, {
      startDelayMs: 0,
      shouldDefer: () => busy,
    });
    maintenance.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(worker.calls).toHaveLength(0);
    busy = false;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(worker.calls).toHaveLength(1);
    maintenance.stop();
  });

  it("reports a failure once and backs off instead of retrying in a loop", async () => {
    vi.useFakeTimers();
    const worker = createWorker([new Error("database is locked")]);
    const errors: unknown[] = [];
    const maintenance = new SyncRunMaintenance(worker, {
      startDelayMs: 0,
      retentionIntervalMs: 60_000,
      onError: (error) => errors.push(error),
    });
    maintenance.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(errors).toHaveLength(1);
    expect(worker.calls).toHaveLength(1);
    maintenance.stop();
  });

  it("does nothing after stop", async () => {
    vi.useFakeTimers();
    const worker = createWorker([]);
    const maintenance = new SyncRunMaintenance(worker, { startDelayMs: 10 });
    maintenance.start();
    maintenance.stop();
    maintenance.purgeAccountHistory("slack", "T1", 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(worker.calls).toHaveLength(0);
  });
});
