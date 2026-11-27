import { describe, expect, it } from "vitest";
import { AdapterWorkerError } from "../../platforms/core/runner.js";
import {
  getAdaptiveProjectionBatchSize,
  getAdaptiveProjectionContinueDelayMs,
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
