import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireSingletonLock,
  readSingletonLock,
  SingletonLockHeldError,
} from "../singleton-lock.js";

describe("singleton lock", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createLockPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "cued-singleton-lock-"));
    tempDirs.push(dir);
    return join(dir, "daemon.lock");
  }

  it("acquires, heartbeats, and releases a lock", async () => {
    let timestamp = 1_700_000_000_000;
    const path = createLockPath();
    const lease = await acquireSingletonLock({
      path,
      kind: "daemon",
      pid: 41,
      now: () => timestamp,
    });

    expect(readSingletonLock(path)).toEqual({
      kind: "daemon",
      pid: 41,
      startedAt: timestamp,
      updatedAt: timestamp,
      version: null,
    });

    timestamp += 5_000;
    lease.heartbeat();
    expect(readSingletonLock(path)?.updatedAt).toBe(timestamp);

    lease.release();
    expect(readSingletonLock(path)).toBeNull();
  });

  it("rejects an active owner", async () => {
    const path = createLockPath();
    writeFileSync(
      path,
      `${JSON.stringify({
        kind: "daemon",
        pid: 99,
        startedAt: 10,
        updatedAt: 20,
        version: "0.1.0",
      })}\n`,
    );

    await expect(
      acquireSingletonLock({
        path,
        kind: "daemon",
        pid: 42,
        now: () => 25,
        staleMs: 15_000,
        isProcessRunning: (pid) => pid === 99,
      }),
    ).rejects.toMatchObject({
      metadata: expect.objectContaining({ pid: 99 }),
    } satisfies Partial<SingletonLockHeldError>);
  });

  it("recovers a stale owner whose pid is gone", async () => {
    const path = createLockPath();
    writeFileSync(
      path,
      `${JSON.stringify({
        kind: "daemon",
        pid: 99,
        startedAt: 10,
        updatedAt: 20,
        version: "0.1.0",
      })}\n`,
    );

    const lease = await acquireSingletonLock({
      path,
      kind: "daemon",
      pid: 42,
      now: () => 30,
      staleMs: 15_000,
      isProcessRunning: () => false,
    });

    expect(readSingletonLock(path)).toEqual({
      kind: "daemon",
      pid: 42,
      startedAt: 30,
      updatedAt: 30,
      version: null,
    });
    lease.release();
  });

  it("recovers a stale lock only when the probe is stale", async () => {
    const path = createLockPath();
    writeFileSync(
      path,
      `${JSON.stringify({
        kind: "daemon",
        pid: 99,
        startedAt: 10,
        updatedAt: 20,
        version: "0.1.0",
      })}\n`,
    );

    await expect(
      acquireSingletonLock({
        path,
        kind: "daemon",
        pid: 42,
        now: () => 30_100,
        staleMs: 15_000,
        isProcessRunning: () => true,
        probe: async () => "active" as const,
      }),
    ).rejects.toBeInstanceOf(SingletonLockHeldError);

    const lease = await acquireSingletonLock({
      path,
      kind: "daemon",
      pid: 42,
      now: () => 30_100,
      staleMs: 15_000,
      isProcessRunning: () => true,
      probe: async () => "stale" as const,
    });

    expect(readSingletonLock(path)?.pid).toBe(42);
    lease.release();
  });

  it("does not overwrite or delete a replacement owner after losing the path", async () => {
    let timestamp = 1_700_000_000_000;
    const path = createLockPath();
    const firstLease = await acquireSingletonLock({
      path,
      kind: "daemon",
      pid: 41,
      now: () => timestamp,
    });

    timestamp += 20_000;
    const replacementLease = await acquireSingletonLock({
      path,
      kind: "daemon",
      pid: 42,
      now: () => timestamp,
      staleMs: 15_000,
      isProcessRunning: () => false,
    });

    firstLease.heartbeat();
    expect(readSingletonLock(path)).toEqual({
      kind: "daemon",
      pid: 42,
      startedAt: timestamp,
      updatedAt: timestamp,
      version: null,
    });

    firstLease.release();
    expect(readSingletonLock(path)?.pid).toBe(42);

    replacementLease.release();
    expect(readSingletonLock(path)).toBeNull();
  });

  it("reads the last valid slot when a newer slot is only partially written", async () => {
    let timestamp = 1_700_000_000_000;
    const path = createLockPath();
    const lease = await acquireSingletonLock({
      path,
      kind: "daemon",
      pid: 41,
      now: () => timestamp,
    });

    timestamp += 5_000;
    lease.heartbeat();
    expect(readSingletonLock(path)?.updatedAt).toBe(timestamp);

    const raw = readFileSync(path);
    const slotBytes = raw.length / 2;
    const fd = openSync(path, "r+");
    try {
      const invalid = Buffer.from("not-json", "utf8");
      writeSync(fd, invalid, 0, invalid.length, slotBytes);
    } finally {
      closeSync(fd);
    }

    expect(readSingletonLock(path)).toEqual({
      kind: "daemon",
      pid: 41,
      startedAt: 1_700_000_000_000,
      updatedAt: timestamp,
      version: null,
    });

    lease.release();
  });
});
