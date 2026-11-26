import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { compareVersions } from "./service.js";
import type { PendingRollbackState } from "./types.js";

/**
 * Removes the copies each update leaves behind, keeping what a rollback could still use.
 *
 * Every update writes, under one stamp `<epoch-ms>-preupdate-<from>-to-<to>`:
 *   - `backups/<stamp>.db`: the database before the update. The update helper copies it back
 *     over the live database if the new version fails its health check.
 *   - `updates/rollback/<stamp>/Cued.app`: the app before the update, restored alongside it.
 *   - `updates/rollback/<stamp>/preflight.db`: a scratch copy the new version migrates to prove
 *     it can open the database. Nothing reads it afterwards.
 * and `updates/downloads/<version>/` holds the downloaded release archive.
 *
 * Retention keeps two stamps: the newest one whose target is the running version (the update
 * that installed what is running now), and the newest one overall (normally the same; when it is
 * not, it is a later attempt that failed or was rolled back). Every other stamp's backup and
 * rollback directory is removed, as are scratch preflight copies and downloads of versions no
 * newer than the running one. Nothing runs while an update is pending, and whatever a pending
 * rollback names is always kept.
 *
 * Only entries matching Cued's own naming are touched. Anything else in these directories, such
 * as a manual backup, is left alone, as are symlinks, anything younger than `minAgeMs`, and the
 * live database with its sidecar files.
 */

const STAMP_PATTERN = /^(\d{10,})-preupdate-([0-9A-Za-z.+-]+?)-to-([0-9A-Za-z.+-]+)$/;
const BACKUP_SUFFIX = ".db";
const SEMVER_DIR_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PREFLIGHT_FILES = [
  "preflight.db",
  "preflight.db-wal",
  "preflight.db-shm",
  "preflight.db-journal",
];
const ROLLBACK_DIR_ENTRIES = new Set(["Cued.app", ...PREFLIGHT_FILES]);
const DOWNLOAD_DIR_ENTRIES = new Set([
  "cued-macos-arm64.tar.gz",
  "cued-macos-arm64.tar.gz.download",
]);
const SQLITE_SIDECARS = ["", "-wal", "-shm", "-journal"];

export const DEFAULT_MIN_AGE_MS = 60 * 60 * 1000;
/** A pending rollback older than this outlived its helper, which gives up within minutes. */
export const STALE_PENDING_ROLLBACK_MS = 24 * 60 * 60 * 1000;

export type UpdateArtifactRetentionOptions = {
  backupsDir: string;
  rollbackDir: string;
  downloadsDir: string;
  dbPath: string;
  currentVersion: string;
  pendingRollback: PendingRollbackState | null;
  now?: number;
  minAgeMs?: number;
};

export type UpdateArtifactRetentionResult = {
  skipped: "pending_rollback" | null;
  removed: string[];
  removedBytes: number;
  failed: { path: string; error: string }[];
};

type Stamp = { name: string; at: number; to: string };

export function parseUpdateStamp(name: string): Stamp | null {
  const match = STAMP_PATTERN.exec(name);
  if (!match) {
    return null;
  }
  const at = Number(match[1]);
  return Number.isSafeInteger(at) ? { name, at, to: match[3] } : null;
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

async function listEntries(dir: string): Promise<string[]> {
  // The directory itself must be a real directory: never follow a symlink somewhere else.
  const stats = await lstatOrNull(dir);
  if (!stats?.isDirectory()) {
    return [];
  }
  return readdir(dir);
}

export async function pruneUpdateArtifacts(
  options: UpdateArtifactRetentionOptions,
): Promise<UpdateArtifactRetentionResult> {
  const now = options.now ?? Date.now();
  const minAgeMs = options.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const result: UpdateArtifactRetentionResult = {
    skipped: null,
    removed: [],
    removedBytes: 0,
    failed: [],
  };

  const pending = options.pendingRollback;
  if (pending && now - pending.startedAt < STALE_PENDING_ROLLBACK_MS) {
    // An update is being applied or verified; its helper may still need any of these copies.
    result.skipped = "pending_rollback";
    return result;
  }

  const protectedPaths = SQLITE_SIDECARS.map((suffix) => resolve(`${options.dbPath}${suffix}`));
  if (pending) {
    protectedPaths.push(resolve(pending.dbBackupPath), resolve(pending.appBackupPath));
  }
  const isProtected = (path: string) => {
    const target = resolve(path);
    return protectedPaths.some(
      (guarded) => guarded === target || guarded.startsWith(`${target}${sep}`),
    );
  };

  const remove = async (path: string, kind: "file" | "dir") => {
    if (isProtected(path)) {
      return;
    }
    const stats = await lstatOrNull(path);
    if (!stats || stats.isSymbolicLink()) {
      return;
    }
    if (kind === "file" ? !stats.isFile() : !stats.isDirectory()) {
      return;
    }
    try {
      // rm never follows symlinks inside a directory it removes; it unlinks them.
      await rm(path, { recursive: kind === "dir", force: true });
      result.removed.push(path);
      if (kind === "file") {
        result.removedBytes += stats.size;
      }
    } catch (error) {
      result.failed.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  };

  // Removes the entries Cued puts in a directory, then the directory only if that left it empty.
  const removeOwnedDir = async (dir: string, ownedEntries: Set<string>) => {
    if (isProtected(dir)) {
      return;
    }
    const stats = await lstatOrNull(dir);
    if (!stats?.isDirectory()) {
      return;
    }
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      result.failed.push({
        path: dir,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    for (const entry of entries) {
      if (ownedEntries.has(entry)) {
        await remove(join(dir, entry), entry.endsWith(".app") ? "dir" : "file");
      }
    }
    try {
      await rmdir(dir);
      result.removed.push(dir);
    } catch {
      // Not empty: something we do not own is inside, so the directory stays.
    }
  };

  const backups: Stamp[] = [];
  for (const entry of await listEntries(options.backupsDir)) {
    const stamp = entry.endsWith(BACKUP_SUFFIX)
      ? parseUpdateStamp(entry.slice(0, -BACKUP_SUFFIX.length))
      : null;
    if (stamp) {
      backups.push(stamp);
    }
  }
  const rollbacks: Stamp[] = [];
  for (const entry of await listEntries(options.rollbackDir)) {
    const stamp = parseUpdateStamp(entry);
    if (stamp) {
      rollbacks.push(stamp);
    }
  }

  const kept = new Set<string>();
  const newest = (stamps: Stamp[]) =>
    stamps.reduce<Stamp | null>(
      (best, stamp) => (!best || stamp.at > best.at ? stamp : best),
      null,
    );
  const all = [...backups, ...rollbacks];
  const newestOverall = newest(all);
  const newestForCurrent = newest(all.filter((stamp) => stamp.to === options.currentVersion));
  for (const stamp of [newestOverall, newestForCurrent]) {
    if (stamp) {
      kept.add(stamp.name);
    }
  }
  const removable = (stamp: Stamp) => !kept.has(stamp.name) && now - stamp.at >= minAgeMs;

  for (const stamp of backups) {
    if (removable(stamp)) {
      await remove(join(options.backupsDir, `${stamp.name}${BACKUP_SUFFIX}`), "file");
    }
  }
  for (const stamp of rollbacks) {
    const dir = join(options.rollbackDir, stamp.name);
    if (removable(stamp)) {
      await removeOwnedDir(dir, ROLLBACK_DIR_ENTRIES);
    } else if (now - stamp.at >= minAgeMs) {
      // A kept rollback only needs its app copy; the scratch preflight database is never read.
      for (const file of PREFLIGHT_FILES) {
        await remove(join(dir, file), "file");
      }
    }
  }

  for (const entry of await listEntries(options.downloadsDir)) {
    if (!SEMVER_DIR_PATTERN.test(entry) || compareVersions(entry, options.currentVersion) > 0) {
      // A newer version may be downloading right now.
      continue;
    }
    const dir = join(options.downloadsDir, entry);
    const stats = await lstatOrNull(dir);
    if (stats?.isDirectory() && now - stats.mtimeMs >= minAgeMs) {
      await removeOwnedDir(dir, DOWNLOAD_DIR_ENTRIES);
    }
  }

  return result;
}

export type UpdateArtifactRetentionSchedule = {
  startDelayMs: number;
  intervalMs: number;
  run: () => Promise<void>;
};

/** Runs retention after startup and then periodically, so a failed removal is retried. */
export function scheduleUpdateArtifactRetention(schedule: UpdateArtifactRetentionSchedule): {
  stop: () => void;
} {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const next = (delayMs: number) => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void schedule
        .run()
        .catch(() => {
          // run reports its own failures; the next pass retries.
        })
        .finally(() => next(schedule.intervalMs));
    }, delayMs);
    timer.unref?.();
  };
  next(schedule.startDelayMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    },
  };
}
