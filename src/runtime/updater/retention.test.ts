import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseUpdateStamp,
  pruneUpdateArtifacts,
  scheduleUpdateArtifactRetention,
} from "./retention.js";
import type { PendingRollbackState } from "./types.js";

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

describe("update artifact retention", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function setup() {
    const home = mkdtempSync(join(tmpdir(), "cued-retention-"));
    tempDirs.push(home);
    const dirs = {
      home,
      backupsDir: join(home, "backups"),
      rollbackDir: join(home, "updates", "rollback"),
      downloadsDir: join(home, "updates", "downloads"),
      dbPath: join(home, "local.db"),
    };
    mkdirSync(dirs.backupsDir, { recursive: true });
    mkdirSync(dirs.rollbackDir, { recursive: true });
    mkdirSync(dirs.downloadsDir, { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      writeFileSync(`${dirs.dbPath}${suffix}`, "live");
    }
    return dirs;
  }

  type Dirs = ReturnType<typeof setup>;

  function addUpdate(dirs: Dirs, at: number, from: string, to: string): string {
    const stamp = `${at}-preupdate-${from}-to-${to}`;
    writeFileSync(join(dirs.backupsDir, `${stamp}.db`), "backup");
    mkdirSync(join(dirs.rollbackDir, stamp, "Cued.app", "Contents"), { recursive: true });
    writeFileSync(join(dirs.rollbackDir, stamp, "Cued.app", "Contents", "Info.plist"), "plist");
    writeFileSync(join(dirs.rollbackDir, stamp, "preflight.db"), "scratch");
    return stamp;
  }

  function addDownload(dirs: Dirs, version: string, at = NOW - 48 * HOUR): string {
    const dir = join(dirs.downloadsDir, version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cued-macos-arm64.tar.gz"), "archive");
    utimesSync(dir, new Date(at), new Date(at));
    return dir;
  }

  function prune(dirs: Dirs, overrides: Partial<Parameters<typeof pruneUpdateArtifacts>[0]> = {}) {
    return pruneUpdateArtifacts({
      backupsDir: dirs.backupsDir,
      rollbackDir: dirs.rollbackDir,
      downloadsDir: dirs.downloadsDir,
      dbPath: dirs.dbPath,
      currentVersion: "0.1.47",
      pendingRollback: null,
      now: NOW,
      ...overrides,
    });
  }

  function pendingFor(dirs: Dirs, stamp: string, startedAt: number): PendingRollbackState {
    return {
      startedAt,
      previousVersion: "0.1.44",
      targetVersion: "0.1.45",
      installedAppPath: "/Applications/Cued.app",
      appBackupPath: join(dirs.rollbackDir, stamp, "Cued.app"),
      dbBackupPath: join(dirs.backupsDir, `${stamp}.db`),
      releaseUrl: null,
    };
  }

  it("parses only Cued's pre-update stamps", () => {
    expect(parseUpdateStamp("1700000000000-preupdate-0.1.46-to-0.1.47")).toEqual({
      name: "1700000000000-preupdate-0.1.46-to-0.1.47",
      at: 1_700_000_000_000,
      to: "0.1.47",
    });
    expect(parseUpdateStamp("1700000000000-preupdate-0.2.0-beta.1-to-0.2.0-beta.2")?.to).toBe(
      "0.2.0-beta.2",
    );
    expect(parseUpdateStamp("my-backup")).toBeNull();
    expect(parseUpdateStamp("1700000000000-preupdate-0.1.46-to-0.1.47 copy")).toBeNull();
    expect(parseUpdateStamp("1700000000000-manual-0.1.46-to-0.1.47")).toBeNull();
    expect(parseUpdateStamp("../1700000000000-preupdate-0.1.46-to-0.1.47")).toBeNull();
  });

  it("keeps only the most recent update's backup and app copy", async () => {
    const dirs = setup();
    const old1 = addUpdate(dirs, NOW - 30 * 24 * HOUR, "0.1.44", "0.1.45");
    const old2 = addUpdate(dirs, NOW - 20 * 24 * HOUR, "0.1.45", "0.1.46");
    const latest = addUpdate(dirs, NOW - 10 * 24 * HOUR, "0.1.46", "0.1.47");
    const oldDownload = addDownload(dirs, "0.1.46");
    const currentDownload = addDownload(dirs, "0.1.47");
    const newerDownload = addDownload(dirs, "0.1.48");

    const result = await prune(dirs);

    expect(result.failed).toEqual([]);
    for (const stamp of [old1, old2]) {
      expect(existsSync(join(dirs.backupsDir, `${stamp}.db`))).toBe(false);
      expect(existsSync(join(dirs.rollbackDir, stamp))).toBe(false);
    }
    expect(existsSync(join(dirs.backupsDir, `${latest}.db`))).toBe(true);
    expect(existsSync(join(dirs.rollbackDir, latest, "Cued.app", "Contents", "Info.plist"))).toBe(
      true,
    );
    // Rollback never reads the scratch preflight copy.
    expect(existsSync(join(dirs.rollbackDir, latest, "preflight.db"))).toBe(false);
    expect(existsSync(oldDownload)).toBe(false);
    expect(existsSync(currentDownload)).toBe(false);
    expect(existsSync(newerDownload)).toBe(true);
    for (const suffix of ["", "-wal", "-shm"]) {
      expect(existsSync(`${dirs.dbPath}${suffix}`)).toBe(true);
    }
    expect(result.removedBytes).toBeGreaterThan(0);
  });

  it("also keeps the update that installed the running version when a later attempt failed", async () => {
    const dirs = setup();
    const older = addUpdate(dirs, NOW - 30 * 24 * HOUR, "0.1.45", "0.1.46");
    const installedCurrent = addUpdate(dirs, NOW - 20 * 24 * HOUR, "0.1.46", "0.1.47");
    const failedAttempt = addUpdate(dirs, NOW - 2 * 24 * HOUR, "0.1.47", "0.1.48");

    await prune(dirs);

    expect(existsSync(join(dirs.backupsDir, `${older}.db`))).toBe(false);
    expect(existsSync(join(dirs.backupsDir, `${installedCurrent}.db`))).toBe(true);
    expect(existsSync(join(dirs.backupsDir, `${failedAttempt}.db`))).toBe(true);
    expect(existsSync(join(dirs.rollbackDir, installedCurrent, "Cued.app"))).toBe(true);
    expect(existsSync(join(dirs.rollbackDir, failedAttempt, "Cued.app"))).toBe(true);
  });

  it("leaves files and directories it did not create untouched", async () => {
    const dirs = setup();
    addUpdate(dirs, NOW - 30 * 24 * HOUR, "0.1.45", "0.1.46");
    addUpdate(dirs, NOW - 10 * 24 * HOUR, "0.1.46", "0.1.47");
    const manualFile = join(dirs.backupsDir, "before-migration.db");
    const manualCopy = join(
      dirs.backupsDir,
      `${NOW - 40 * 24 * HOUR}-preupdate-0.1.40-to-0.1.41 copy.db`,
    );
    const manualDir = join(dirs.backupsDir, "manual");
    const lookalikeDir = join(
      dirs.backupsDir,
      `${NOW - 40 * 24 * HOUR}-preupdate-0.1.40-to-0.1.41.db`,
    );
    const rollbackNote = join(dirs.rollbackDir, "notes.txt");
    const downloadNote = join(dirs.downloadsDir, "keep-me");
    writeFileSync(manualFile, "mine");
    writeFileSync(manualCopy, "mine");
    mkdirSync(manualDir);
    writeFileSync(join(manualDir, "local.db"), "mine");
    mkdirSync(lookalikeDir);
    writeFileSync(rollbackNote, "mine");
    mkdirSync(downloadNote);
    // A user file inside an old rollback directory keeps that directory, but not Cued's copies.
    const oldWithExtra = addUpdate(dirs, NOW - 50 * 24 * HOUR, "0.1.40", "0.1.41");
    writeFileSync(join(dirs.rollbackDir, oldWithExtra, "readme.txt"), "mine");
    const oldDownload = addDownload(dirs, "0.1.40");
    writeFileSync(join(oldDownload, "notes.txt"), "mine");

    await prune(dirs);

    for (const path of [
      manualFile,
      manualCopy,
      join(manualDir, "local.db"),
      lookalikeDir,
      rollbackNote,
      downloadNote,
    ]) {
      expect(existsSync(path)).toBe(true);
    }
    expect(existsSync(join(dirs.rollbackDir, oldWithExtra, "readme.txt"))).toBe(true);
    expect(existsSync(join(dirs.rollbackDir, oldWithExtra, "Cued.app"))).toBe(false);
    expect(existsSync(join(oldDownload, "notes.txt"))).toBe(true);
    expect(existsSync(join(oldDownload, "cued-macos-arm64.tar.gz"))).toBe(false);
  });

  it("does not follow symlinks out of its directories", async () => {
    const dirs = setup();
    const outside = mkdtempSync(join(tmpdir(), "cued-retention-outside-"));
    tempDirs.push(outside);
    mkdirSync(join(outside, "Cued.app"));
    writeFileSync(join(outside, "Cued.app", "file"), "outside");
    writeFileSync(join(outside, "target.db"), "outside");
    addUpdate(dirs, NOW - 10 * 24 * HOUR, "0.1.46", "0.1.47");
    const linkedStamp = `${NOW - 30 * 24 * HOUR}-preupdate-0.1.45-to-0.1.46`;
    symlinkSync(outside, join(dirs.rollbackDir, linkedStamp));
    symlinkSync(join(outside, "target.db"), join(dirs.backupsDir, `${linkedStamp}.db`));
    const oldStamp = addUpdate(dirs, NOW - 40 * 24 * HOUR, "0.1.44", "0.1.45");
    rmSync(join(dirs.rollbackDir, oldStamp, "Cued.app"), { recursive: true });
    symlinkSync(join(outside, "Cued.app"), join(dirs.rollbackDir, oldStamp, "Cued.app"));

    const result = await prune(dirs);

    expect(result.failed).toEqual([]);
    expect(existsSync(join(outside, "Cued.app", "file"))).toBe(true);
    expect(existsSync(join(outside, "target.db"))).toBe(true);
    expect(existsSync(join(dirs.rollbackDir, linkedStamp))).toBe(true);
    expect(existsSync(join(dirs.backupsDir, `${linkedStamp}.db`))).toBe(true);
  });

  it("removes nothing while an update is pending", async () => {
    const dirs = setup();
    const older = addUpdate(dirs, NOW - 30 * 24 * HOUR, "0.1.44", "0.1.45");
    addUpdate(dirs, NOW - 10 * 24 * HOUR, "0.1.46", "0.1.47");
    const download = addDownload(dirs, "0.1.46");

    const result = await prune(dirs, { pendingRollback: pendingFor(dirs, older, NOW - HOUR) });

    expect(result.skipped).toBe("pending_rollback");
    expect(result.removed).toEqual([]);
    expect(existsSync(join(dirs.backupsDir, `${older}.db`))).toBe(true);
    expect(existsSync(join(dirs.rollbackDir, older, "Cued.app"))).toBe(true);
    expect(existsSync(download)).toBe(true);
  });

  it("keeps the copies a stale pending rollback names", async () => {
    const dirs = setup();
    const named = addUpdate(dirs, NOW - 30 * 24 * HOUR, "0.1.44", "0.1.45");
    const other = addUpdate(dirs, NOW - 25 * 24 * HOUR, "0.1.45", "0.1.46");
    addUpdate(dirs, NOW - 10 * 24 * HOUR, "0.1.46", "0.1.47");

    const result = await prune(dirs, {
      pendingRollback: pendingFor(dirs, named, NOW - 30 * 24 * HOUR),
    });

    expect(result.skipped).toBeNull();
    expect(existsSync(join(dirs.backupsDir, `${named}.db`))).toBe(true);
    expect(existsSync(join(dirs.rollbackDir, named, "Cued.app", "Contents", "Info.plist"))).toBe(
      true,
    );
    expect(existsSync(join(dirs.backupsDir, `${other}.db`))).toBe(false);
  });

  it("leaves recent copies alone in case an install is still writing them", async () => {
    const dirs = setup();
    const recentOld = addUpdate(dirs, NOW - 30 * 60 * 1000, "0.1.45", "0.1.46");
    addUpdate(dirs, NOW - 10 * 60 * 1000, "0.1.46", "0.1.47");
    const recentDownload = addDownload(dirs, "0.1.46", NOW - 5 * 60 * 1000);

    await prune(dirs);

    expect(existsSync(join(dirs.backupsDir, `${recentOld}.db`))).toBe(true);
    expect(existsSync(join(dirs.rollbackDir, recentOld, "preflight.db"))).toBe(true);
    expect(existsSync(recentDownload)).toBe(true);
  });

  it("never removes the live database even if it is configured inside the backups directory", async () => {
    const dirs = setup();
    const liveStamp = addUpdate(dirs, NOW - 30 * 24 * HOUR, "0.1.45", "0.1.46");
    addUpdate(dirs, NOW - 10 * 24 * HOUR, "0.1.46", "0.1.47");
    const liveDb = join(dirs.backupsDir, `${liveStamp}.db`);

    await prune(dirs, { dbPath: liveDb });

    expect(existsSync(liveDb)).toBe(true);
  });

  it("does nothing when its directories are missing", async () => {
    const dirs = setup();
    rmSync(dirs.backupsDir, { recursive: true });
    rmSync(join(dirs.home, "updates"), { recursive: true });

    const result = await prune(dirs);

    expect(result).toEqual({ skipped: null, removed: [], removedBytes: 0, failed: [] });
  });

  it("reports a failed removal instead of throwing", async () => {
    const dirs = setup();
    const old = addUpdate(dirs, NOW - 30 * 24 * HOUR, "0.1.45", "0.1.46");
    addUpdate(dirs, NOW - 10 * 24 * HOUR, "0.1.46", "0.1.47");
    chmodSync(dirs.backupsDir, 0o500);
    try {
      const result = await prune(dirs);
      expect(result.failed.map((failure) => failure.path)).toContain(
        join(dirs.backupsDir, `${old}.db`),
      );
      expect(existsSync(join(dirs.backupsDir, `${old}.db`))).toBe(true);
    } finally {
      chmodSync(dirs.backupsDir, 0o700);
    }
  });

  it("runs after the start delay and keeps retrying after a failure", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(undefined);
      const schedule = scheduleUpdateArtifactRetention({
        startDelayMs: 1_000,
        intervalMs: 5_000,
        run,
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(run).toHaveBeenCalledTimes(2);
      schedule.stop();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
