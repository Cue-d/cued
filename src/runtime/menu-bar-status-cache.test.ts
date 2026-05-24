import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readMenuBarStatusCache,
  readMenuBarStatusSnapshot,
  removeMenuBarStatusCache,
  writeMenuBarStatusCache,
} from "./menu-bar-status-cache.js";

describe("menu bar status cache", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createStatusPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "cued-menu-bar-cache-"));
    tempDirs.push(dir);
    return join(dir, "menu-bar-status.json");
  }

  it("writes and reads a status snapshot atomically", () => {
    const statusPath = createStatusPath();

    writeMenuBarStatusCache(
      {
        dbPath: "/tmp/cued-test/local.db",
        overview: { messages: 12 },
      },
      { statusPath, pid: 1234 },
    );

    expect(readFileSync(statusPath, "utf8")).toBe(
      '{"dbPath":"/tmp/cued-test/local.db","overview":{"messages":12}}\n',
    );
    expect(readMenuBarStatusCache({ statusPath, dbPath: "/tmp/cued-test/local.db" })).toEqual(
      expect.objectContaining({
        path: statusPath,
        snapshot: {
          dbPath: "/tmp/cued-test/local.db",
          overview: { messages: 12 },
        },
        mtimeMs: expect.any(Number),
      }),
    );
    expect(readMenuBarStatusSnapshot({ statusPath, dbPath: "/tmp/cued-test/local.db" })).toEqual({
      dbPath: "/tmp/cued-test/local.db",
      overview: { messages: 12 },
    });
  });

  it("rejects stale, invalid, and wrong-database cache entries", () => {
    const statusPath = createStatusPath();
    writeFileSync(statusPath, '{"dbPath":"/tmp/other.db"}\n');
    const cached = readMenuBarStatusCache({ statusPath });
    expect(cached).not.toBeNull();

    expect(readMenuBarStatusCache({ statusPath, dbPath: "/tmp/current.db" })).toBeNull();
    expect(
      readMenuBarStatusCache({
        statusPath,
        maxAgeMs: 1,
        now: () => (cached?.mtimeMs ?? 0) + 2,
      }),
    ).toBeNull();

    writeFileSync(statusPath, "[]\n");
    expect(readMenuBarStatusCache({ statusPath })).toBeNull();
  });

  it("removes the cache without requiring callers to know the path constant", () => {
    const statusPath = createStatusPath();
    writeMenuBarStatusCache({ ok: true }, { statusPath });

    removeMenuBarStatusCache({ statusPath });

    expect(readMenuBarStatusCache({ statusPath })).toBeNull();
  });
});
