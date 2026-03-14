import { describe, expect, it } from "vitest";
import {
  buildProjectionMessageHookBatches,
  ProjectionMessageHookBarrier,
} from "../services/projection.js";

describe("ProjectionMessageHookBarrier", () => {
  it("releases only batches fully covered by completed projection ranges", async () => {
    const barrier = new ProjectionMessageHookBarrier();
    const emitted: string[] = [];

    barrier.enqueue({ startRowId: 10, endRowId: 12 }, [{ id: "first-a" }, { id: "first-b" }]);
    barrier.enqueue({ startRowId: 13, endRowId: 15 }, [{ id: "second" }]);

    await barrier.releaseCompletedRange({ startRowId: 10, endRowId: 12 }, async (payload) => {
      emitted.push(String(payload.id));
    });
    expect(emitted).toEqual(["first-a", "first-b"]);

    await barrier.releaseCompletedRange({ startRowId: 13, endRowId: 14 }, async (payload) => {
      emitted.push(String(payload.id));
    });
    expect(emitted).toEqual(["first-a", "first-b"]);

    await barrier.releaseCompletedRange({ startRowId: 13, endRowId: 15 }, async (payload) => {
      emitted.push(String(payload.id));
    });
    expect(emitted).toEqual(["first-a", "first-b", "second"]);
  });

  it("flushes all pending batches in row order", async () => {
    const barrier = new ProjectionMessageHookBarrier();
    const emitted: string[] = [];

    barrier.enqueue({ startRowId: 20, endRowId: 21 }, [{ id: "later" }]);
    barrier.enqueue({ startRowId: 10, endRowId: 12 }, [{ id: "earlier-a" }, { id: "earlier-b" }]);

    await barrier.releaseAll(async (payload) => {
      emitted.push(String(payload.id));
    });
    expect(emitted).toEqual(["earlier-a", "earlier-b", "later"]);

    await barrier.releaseAll(async (payload) => {
      emitted.push(String(payload.id));
    });
    expect(emitted).toEqual(["earlier-a", "earlier-b", "later"]);
  });

  it("splits queued hook payloads by projection page so paginated runs can release them", () => {
    expect(
      buildProjectionMessageHookBatches(
        { startRowId: 100, endRowId: 2000 },
        [
          { rowId: 150, payload: { id: "page-1" } },
          { rowId: 1100, payload: { id: "page-2" } },
          { rowId: 1999, payload: { id: "page-2b" } },
        ],
        1000,
      ),
    ).toEqual([
      {
        startRowId: 100,
        endRowId: 1099,
        payloads: [{ id: "page-1" }],
      },
      {
        startRowId: 1100,
        endRowId: 2000,
        payloads: [{ id: "page-2" }, { id: "page-2b" }],
      },
    ]);
  });
});
