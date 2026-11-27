import { describe, expect, it, vi } from "vitest";
import { AdapterWorkerError } from "../../platforms/core/runner.js";
import {
  getAdaptiveProjectionBatchSize,
  getAdaptiveProjectionContinueDelayMs,
  IngestRunSupersededError,
  insertRawEventsYielding,
  isAdapterAuthInvalidation,
  isDisconnectedSocketError,
  shouldDeferContinuationProjection,
  shouldProjectIngestRunInline,
} from "./server.js";

describe("adapter auth invalidation", () => {
  it.each([
    "linkedin",
    "slack",
    "gmail",
  ])("recognizes typed %s auth failures from adapter workers", (platform) => {
    expect(
      isAdapterAuthInvalidation(
        platform,
        new AdapterWorkerError("Authentication failed", "auth_invalid"),
      ),
    ).toBe(true);
  });

  it("does not invalidate auth for transient or unrelated adapter failures", () => {
    expect(
      isAdapterAuthInvalidation("linkedin", new AdapterWorkerError("LinkedIn rate limited")),
    ).toBe(false);
    expect(
      isAdapterAuthInvalidation(
        "imessage",
        new AdapterWorkerError("Authentication failed", "auth_invalid"),
      ),
    ).toBe(false);
  });
});

describe("ingest projection strategy", () => {
  it("defers discord sync projection so run completion is not coupled to projection", () => {
    expect(
      shouldProjectIngestRunInline({
        platform: "discord",
        runType: "sync",
        realtimeProjectionEnabled: true,
        firstInsertedRowId: 1,
        lastInsertedRowId: 373,
        insertedRawEvents: 373,
      }),
    ).toBe(false);
  });

  it("keeps inline projection only for small non-resume batches when enabled", () => {
    expect(
      shouldProjectIngestRunInline({
        platform: "slack",
        runType: "sync",
        realtimeProjectionEnabled: true,
        firstInsertedRowId: 1,
        lastInsertedRowId: 10,
        insertedRawEvents: 10,
      }),
    ).toBe(true);
    expect(
      shouldProjectIngestRunInline({
        platform: "slack",
        runType: "sync",
        realtimeProjectionEnabled: false,
        firstInsertedRowId: 1,
        lastInsertedRowId: 10,
        insertedRawEvents: 10,
      }),
    ).toBe(false);
    expect(
      shouldProjectIngestRunInline({
        platform: "imessage",
        runType: "sync_resume",
        realtimeProjectionEnabled: true,
        firstInsertedRowId: 1,
        lastInsertedRowId: 10,
        insertedRawEvents: 10,
      }),
    ).toBe(false);
    expect(
      shouldProjectIngestRunInline({
        platform: "imessage",
        runType: "sync",
        realtimeProjectionEnabled: true,
        firstInsertedRowId: 1,
        lastInsertedRowId: 2_000,
        insertedRawEvents: 2_000,
      }),
    ).toBe(false);
  });
});

describe("daemon socket errors", () => {
  it("classifies disconnected clients as non-fatal IPC errors", () => {
    for (const code of ["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED"]) {
      const error = new Error(code) as NodeJS.ErrnoException;
      error.code = code;
      expect(isDisconnectedSocketError(error)).toBe(true);
    }
  });

  it("does not hide unexpected socket errors", () => {
    const error = new Error("permission denied") as NodeJS.ErrnoException;
    error.code = "EACCES";
    expect(isDisconnectedSocketError(error)).toBe(false);
    expect(isDisconnectedSocketError("EPIPE")).toBe(false);
  });
});

describe("adaptive projection scheduling", () => {
  it("coalesces only small continuation projection backlogs inside the interval", () => {
    expect(
      shouldDeferContinuationProjection({
        hasMore: true,
        pendingRawEvents: 100,
        lastProjectionQueuedAt: 1_000,
        nowMs: 2_500,
        intervalMs: 2_000,
        backlogEvents: 500,
      }),
    ).toBe(true);
    expect(
      shouldDeferContinuationProjection({
        hasMore: true,
        pendingRawEvents: 500,
        lastProjectionQueuedAt: 1_000,
        nowMs: 2_500,
        intervalMs: 2_000,
        backlogEvents: 500,
      }),
    ).toBe(false);
    expect(
      shouldDeferContinuationProjection({
        hasMore: true,
        pendingRawEvents: 100,
        lastProjectionQueuedAt: 1_000,
        nowMs: 3_001,
        intervalMs: 2_000,
        backlogEvents: 500,
      }),
    ).toBe(false);
    expect(
      shouldDeferContinuationProjection({
        hasMore: false,
        pendingRawEvents: 100,
        lastProjectionQueuedAt: 1_000,
        nowMs: 2_500,
        intervalMs: 2_000,
        backlogEvents: 500,
      }),
    ).toBe(false);
    expect(
      shouldDeferContinuationProjection({
        hasMore: true,
        pendingRawEvents: 0,
        lastProjectionQueuedAt: 1_000,
        nowMs: 2_500,
        intervalMs: 2_000,
        backlogEvents: 500,
      }),
    ).toBe(false);
  });

  it("uses larger batches for large backlogs", () => {
    expect(getAdaptiveProjectionBatchSize(0)).toBe(100);
    expect(getAdaptiveProjectionBatchSize(1_000)).toBe(500);
    expect(getAdaptiveProjectionBatchSize(5_000)).toBe(1_000);
    expect(getAdaptiveProjectionBatchSize(25_000)).toBe(1_500);
    expect(getAdaptiveProjectionBatchSize(100_000)).toBe(2_000);
  });

  it("delays continuation only for a trickle too small to justify a worker", () => {
    expect(getAdaptiveProjectionContinueDelayMs(99)).toBe(5_000);
    expect(getAdaptiveProjectionContinueDelayMs(100)).toBe(0);
    expect(getAdaptiveProjectionContinueDelayMs(999)).toBe(0);
    expect(getAdaptiveProjectionContinueDelayMs(5_000)).toBe(0);
    expect(getAdaptiveProjectionContinueDelayMs(25_000)).toBe(0);
    expect(getAdaptiveProjectionContinueDelayMs(100_000)).toBe(0);
  });
});

describe("yielding raw event insert", () => {
  it("inserts a bundle in slices, lets other work run between them, and merges the results", async () => {
    const slices: number[] = [];
    let nextRowId = 1;
    let otherWorkRan = 0;
    const db = {
      insertRawEvents: (events: Array<{ id: string }>) => {
        slices.push(events.length);
        // Hold the thread long enough that the slice budget is spent after every call.
        const until = performance.now() + 12;
        while (performance.now() < until) {
          // busy-wait
        }
        const insertedRows = events.map((event) => ({ rowId: nextRowId++, event }));
        return {
          insertedCount: events.length,
          insertedEvents: events,
          insertedRows,
          firstInsertedRowId: insertedRows[0]?.rowId ?? null,
          lastInsertedRowId: insertedRows[insertedRows.length - 1]?.rowId ?? null,
        };
      },
    };
    const events = Array.from({ length: 120 }, (_, index) => ({ id: `event-${index}` }));
    const ticker = setInterval(() => {
      otherWorkRan += 1;
    }, 1);

    const result = await insertRawEventsYielding(db as never, events as never);
    clearInterval(ticker);

    expect(slices).toEqual([50, 50, 20]);
    expect(otherWorkRan).toBeGreaterThan(0);
    expect(result).toEqual(
      expect.objectContaining({
        insertedCount: 120,
        firstInsertedRowId: 1,
        lastInsertedRowId: 120,
      }),
    );
    expect(result.insertedRows).toHaveLength(120);
  });

  it("reports each slice as it lands and stops when the run is no longer wanted", async () => {
    let nextRowId = 1;
    const db = {
      insertRawEvents: (events: Array<{ id: string }>) => {
        const until = performance.now() + 12;
        while (performance.now() < until) {
          // busy-wait so every slice spends the budget and yields
        }
        const insertedRows = events.map((event) => ({ rowId: nextRowId++, event }));
        return {
          insertedCount: events.length,
          insertedEvents: events,
          insertedRows,
          firstInsertedRowId: insertedRows[0]?.rowId ?? null,
          lastInsertedRowId: insertedRows[insertedRows.length - 1]?.rowId ?? null,
        };
      },
    };
    const events = Array.from({ length: 120 }, (_, index) => ({ id: `event-${index}` }));
    const landed: Array<[number | null, number | null]> = [];
    let yields = 0;

    await expect(
      insertRawEventsYielding(db as never, events as never, {
        onInserted: (inserted) =>
          landed.push([inserted.firstInsertedRowId, inserted.lastInsertedRowId]),
        assertStillWanted: () => {
          yields += 1;
          if (yields === 2) {
            throw new IngestRunSupersededError("run-1");
          }
        },
      }),
    ).rejects.toBeInstanceOf(IngestRunSupersededError);

    // Two slices landed, each announced in the same turn as its insert; the third never ran.
    expect(landed).toEqual([
      [1, 50],
      [51, 100],
    ]);
  });

  it("does nothing for an empty bundle", async () => {
    const db = { insertRawEvents: vi.fn() };
    const result = await insertRawEventsYielding(db as never, []);
    expect(db.insertRawEvents).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        insertedCount: 0,
        firstInsertedRowId: null,
        lastInsertedRowId: null,
      }),
    );
  });
});
