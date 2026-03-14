import { describe, expect, it } from "vitest";
import { ProjectionMessageHookBarrier } from "../services/projection.js";

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
});
