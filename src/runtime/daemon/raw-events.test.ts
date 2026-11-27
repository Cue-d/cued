import { describe, expect, it, vi } from "vitest";
import { IngestRunSupersededError } from "./ingest-run.js";
import { insertRawEventsYielding } from "./raw-events.js";

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
