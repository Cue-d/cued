import { afterEach, describe, expect, it, vi } from "vitest";

const projectDeferredRangeMock = vi.hoisted(() => vi.fn());

vi.mock("./projector.js", () => ({
  projectDeferredRange: projectDeferredRangeMock,
  projectPendingRawEvents: vi.fn(),
  rebuildProjectedState: vi.fn(),
}));

import { projectRangeInChunks } from "./worker.js";

function chunkResult(input: { applied: number; next: number | null; end: number }) {
  return {
    contacts: 0,
    conversations: 0,
    messages: 0,
    rawEvents: 0,
    appliedRawEvents: input.applied,
    projectionWatermark: (input.next ?? input.end + 1) - 1,
    completed: input.next == null,
    nextStartRowId: input.next,
    rangeStartRowId: 0,
    rangeEndRowId: input.end,
  };
}

describe("chunked projection", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  /** A clock that advances by a scripted amount around each projected chunk. */
  function scriptedClock(chunkDurationsMs: number[]) {
    let nowMs = 0;
    let reads = 0;
    return () => {
      // Read once before and once after each chunk; the second read lands after the work.
      if (reads % 2 === 1) {
        nowMs += chunkDurationsMs[(reads - 1) / 2] ?? 0;
      }
      reads += 1;
      return nowMs;
    };
  }

  function requestedChunks() {
    return projectDeferredRangeMock.mock.calls.map(([, options]) => [
      options.startRowId,
      options.limit,
    ]);
  }

  it("shrinks its transactions when events are slow to project", () => {
    projectDeferredRangeMock
      .mockReturnValueOnce(chunkResult({ applied: 10, next: 111, end: 900 }))
      .mockReturnValueOnce(chunkResult({ applied: 2, next: 113, end: 900 }))
      .mockReturnValueOnce(chunkResult({ applied: 2, next: 115, end: 900 }));

    // 10 events took 100 ms (10 ms each): a 15 ms transaction fits about two.
    const result = projectRangeInChunks({} as never, { startRowId: 101, endRowId: 900 }, 14, {
      targetTransactionMs: 15,
      initialTransactionEvents: 10,
      restMs: 0,
      clock: scriptedClock([100, 20, 20]),
    });

    expect(requestedChunks()).toEqual([
      [101, 10],
      [111, 2],
      [113, 2],
    ]);
    expect(result).toEqual(
      expect.objectContaining({
        appliedRawEvents: 14,
        rangeStartRowId: 101,
        // More of the range is left: the daemon queues the continuation from here.
        nextStartRowId: 115,
        completed: false,
      }),
    );
  });

  it("grows its transactions when events are quick, without overshooting", () => {
    projectDeferredRangeMock
      .mockReturnValueOnce(chunkResult({ applied: 10, next: 11, end: 900 }))
      .mockReturnValueOnce(chunkResult({ applied: 20, next: 31, end: 900 }))
      .mockReturnValueOnce(chunkResult({ applied: 40, next: 71, end: 900 }))
      .mockReturnValueOnce(chunkResult({ applied: 50, next: 121, end: 900 }));

    // Events take 0.1 ms: the size at most doubles per step, then holds at the cap.
    projectRangeInChunks({} as never, { startRowId: 1, endRowId: 900 }, 120, {
      targetTransactionMs: 15,
      initialTransactionEvents: 10,
      maxTransactionEvents: 50,
      restMs: 0,
      clock: scriptedClock([1, 2, 4, 5]),
    });

    expect(requestedChunks().map(([, limit]) => limit)).toEqual([10, 20, 40, 50]);
  });

  it("stops as soon as the range is exhausted", () => {
    projectDeferredRangeMock
      .mockReturnValueOnce(chunkResult({ applied: 10, next: 11, end: 15 }))
      .mockReturnValueOnce(chunkResult({ applied: 5, next: null, end: 15 }));

    const result = projectRangeInChunks({} as never, { startRowId: 1, endRowId: 15 }, 500, {
      restMs: 0,
      clock: scriptedClock([15, 15]),
    });

    expect(projectDeferredRangeMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual(
      expect.objectContaining({ appliedRawEvents: 15, nextStartRowId: null, completed: true }),
    );
  });
});
