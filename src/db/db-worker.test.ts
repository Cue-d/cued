import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CuedDatabase } from "./database.js";
import {
  type DbWorker,
  DbWorkerUnavailableError,
  InlineDbWorker,
  ResilientDbWorker,
} from "./db-worker.js";

describe("database worker", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createDb(): CuedDatabase {
    const dir = mkdtempSync(join(tmpdir(), "cued-db-worker-"));
    dirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
    return db;
  }

  function failingWorker(error: Error): DbWorker & { run: ReturnType<typeof vi.fn> } {
    return {
      run: vi.fn(async () => {
        throw error;
      }) as never,
      close: async () => {},
    };
  }

  it("runs jobs inline against the caller's connection", async () => {
    const db = createDb();
    try {
      const worker = new InlineDbWorker(db);
      expect(await worker.run("sql", "SELECT 1 AS one")).toEqual([{ one: 1 }]);
      expect(await worker.run("statusAggregates")).toEqual(
        expect.objectContaining({ phoneCalls: 0 }),
      );
      expect(await worker.run("pruneSyncRunHistory", { batchSize: 10, maxBatches: 2 })).toEqual({
        deleted: 0,
        more: false,
      });
      expect(await worker.run("checkpointWal")).toEqual(
        expect.objectContaining({ walFrames: expect.any(Number) }),
      );
    } finally {
      db.close();
    }
  });

  it("returns BLOB columns in the shape JSON gives a Buffer", async () => {
    const db = createDb();
    try {
      const [row] = await new InlineDbWorker(db).run("sql", "SELECT x'0102' AS bytes, 'a' AS text");
      // A worker thread hands back a plain typed array, which would serialize as
      // {"0":1,"1":2}; the job converts it first so `cued sql` output does not change.
      expect(JSON.parse(JSON.stringify(row))).toEqual({
        bytes: { type: "Buffer", data: [1, 2] },
        text: "a",
      });
      expect(JSON.stringify(row)).toBe(
        JSON.stringify(db.executeReadOnlySql("SELECT x'0102' AS bytes, 'a' AS text")[0]),
      );
    } finally {
      db.close();
    }
  });

  it("falls back to inline, and stays there, when the worker thread cannot run", async () => {
    const db = createDb();
    try {
      const primary = failingWorker(new DbWorkerUnavailableError("thread would not start"));
      const degraded = vi.fn();
      const worker = new ResilientDbWorker(primary, new InlineDbWorker(db), degraded);

      expect(await worker.run("sql", "SELECT 2 AS two")).toEqual([{ two: 2 }]);
      expect(await worker.run("sql", "SELECT 3 AS three")).toEqual([{ three: 3 }]);
      expect(primary.run).toHaveBeenCalledTimes(1);
      expect(degraded).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it("passes a job's own error through without falling back", async () => {
    const db = createDb();
    try {
      const primary = failingWorker(new Error("no such table: nope"));
      const worker = new ResilientDbWorker(primary, new InlineDbWorker(db));
      await expect(worker.run("sql", "SELECT * FROM nope")).rejects.toThrow("no such table");
      await expect(worker.run("sql", "SELECT 1")).rejects.toThrow("no such table");
      expect(primary.run).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
    }
  });
});
