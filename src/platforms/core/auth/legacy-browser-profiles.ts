import type { Dirent } from "node:fs";
import { lstat, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { AUTH_BROWSER_PROFILE_IDS } from "./browser-resolver.js";

/**
 * Removes the sign-in browser profiles left by the Chromium that Cued used to bundle.
 *
 * Until the bundled Chromium was dropped, each sign-in browser opened its profile directly in
 * the account's profile directory, `<data>/browser/<platform>/<account>/` (the
 * `browserProfileDir` integration metadata): `Local State`, `Default/`, caches and so on. Now
 * every browser opens its own subdirectory, `<data>/browser/<platform>/<account>/<browser-id>`
 * (`authBrowserProfileDir`), and the account directory is otherwise only ever moved or removed
 * whole. So in an account directory, everything except the per-browser subdirectories named in
 * `AUTH_BROWSER_PROFILE_IDS` is the old profile, and nothing reads it. Sessions live in the
 * keychain, so removing it signs nobody out.
 *
 * An account directory counts as an old profile only while it still has Chromium's `Local
 * State` file, which is removed last, so a pass interrupted halfway is finished by the next.
 * Symlinks are never followed: a linked platform or account directory is skipped, and of
 * linked entries only Chromium's own `Singleton*` lock links are unlinked (the link itself).
 * Nothing runs while a sign-in is in progress, because finishing one can move the account
 * directory. Once a pass finds nothing left to do, a marker in the browser directory stops
 * later passes.
 */

export const LEGACY_PROFILES_MARKER = ".legacy-profiles-removed";
const LEGACY_PROFILE_MARKER_ENTRY = "Local State";
const CHROMIUM_LOCK_LINK = /^Singleton(Lock|Socket|Cookie)$/;

export type LegacyBrowserProfileCleanupOptions = {
  /** Cued's data directory. Nothing outside it is touched. */
  cuedHome: string;
  /** `<cuedHome>/browser`. */
  browserRoot: string;
  /** True while any sign-in window may be open or finishing. Checked before each account. */
  isSignInActive: () => boolean;
};

export type LegacyBrowserProfileCleanupResult = {
  skipped: "already_done" | "sign_in_active" | "outside_data_dir" | null;
  /** Account directories whose old profile was removed. */
  profiles: string[];
  removedEntries: number;
  removedBytes: number;
  failed: { path: string; error: string }[];
};

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

async function readdirOrEmpty(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isStrictlyInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Bytes under `path`, counted without following any symlink. */
async function treeBytes(path: string): Promise<number> {
  const stats = await lstatOrNull(path);
  if (!stats) return 0;
  if (!stats.isDirectory()) return stats.isFile() ? stats.size : 0;
  let total = 0;
  for (const entry of await readdirOrEmpty(path)) {
    total += await treeBytes(join(path, entry.name));
  }
  return total;
}

export async function pruneLegacyBrowserProfiles(
  options: LegacyBrowserProfileCleanupOptions,
): Promise<LegacyBrowserProfileCleanupResult> {
  const result: LegacyBrowserProfileCleanupResult = {
    skipped: null,
    profiles: [],
    removedEntries: 0,
    removedBytes: 0,
    failed: [],
  };
  const rootStats = await lstatOrNull(options.browserRoot);
  if (!rootStats) {
    result.skipped = "already_done";
    return result;
  }
  if (!rootStats.isDirectory()) {
    result.skipped = "outside_data_dir";
    return result;
  }
  if (await lstatOrNull(join(options.browserRoot, LEGACY_PROFILES_MARKER))) {
    result.skipped = "already_done";
    return result;
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(options.browserRoot);
    if (!isStrictlyInside(await realpath(options.cuedHome), canonicalRoot)) {
      result.skipped = "outside_data_dir";
      return result;
    }
  } catch {
    result.skipped = "outside_data_dir";
    return result;
  }

  for (const platform of await readdirOrEmpty(canonicalRoot)) {
    // Dirent types come from lstat: a symlinked platform directory is not a directory here.
    if (!platform.isDirectory()) continue;
    const platformDir = join(canonicalRoot, platform.name);
    for (const account of await readdirOrEmpty(platformDir)) {
      if (!account.isDirectory()) continue;
      if (options.isSignInActive()) {
        result.skipped = "sign_in_active";
        return result;
      }
      await pruneAccountDir(canonicalRoot, join(platformDir, account.name), result);
    }
  }

  if (result.failed.length === 0) {
    try {
      await writeFile(join(canonicalRoot, LEGACY_PROFILES_MARKER), `${Date.now()}\n`, {
        mode: 0o600,
        flag: "wx",
      });
    } catch {
      // Without the marker the next pass looks again and finds nothing to remove.
    }
  }
  return result;
}

async function pruneAccountDir(
  canonicalRoot: string,
  accountDir: string,
  result: LegacyBrowserProfileCleanupResult,
): Promise<void> {
  const marker = await lstatOrNull(join(accountDir, LEGACY_PROFILE_MARKER_ENTRY));
  if (!marker?.isFile()) return;
  // The account directory must still be where it was listed, with no link on the way.
  try {
    if (
      (await realpath(accountDir)) !== accountDir ||
      !isStrictlyInside(canonicalRoot, accountDir)
    ) {
      return;
    }
  } catch {
    return;
  }

  const entries = (await readdirOrEmpty(accountDir)).filter(
    (entry) => !AUTH_BROWSER_PROFILE_IDS.has(entry.name),
  );
  // `Local State` last: while it exists, the next pass knows there is more to remove.
  entries.sort(
    (a, b) =>
      Number(a.name === LEGACY_PROFILE_MARKER_ENTRY) -
      Number(b.name === LEGACY_PROFILE_MARKER_ENTRY),
  );
  let removedAny = false;
  let failedAny = false;
  for (const entry of entries) {
    // Something could not be removed: keep `Local State`, or the retry would no longer
    // recognise this directory as an old profile and would leave the rest behind.
    if (failedAny && entry.name === LEGACY_PROFILE_MARKER_ENTRY) continue;
    const path = join(accountDir, entry.name);
    const stats = await lstatOrNull(path);
    if (!stats) continue;
    try {
      if (stats.isSymbolicLink()) {
        if (!CHROMIUM_LOCK_LINK.test(entry.name)) continue;
        // Removes the link only; its target (a host-pid string) is never resolved.
        await unlink(path);
      } else if (stats.isDirectory()) {
        const bytes = await treeBytes(path);
        // rm unlinks symlinks inside a directory it removes; it never follows them.
        await rm(path, { recursive: true, force: true });
        result.removedBytes += bytes;
      } else if (stats.isFile()) {
        await rm(path, { force: true });
        result.removedBytes += stats.size;
      } else {
        continue;
      }
      result.removedEntries += 1;
      removedAny = true;
    } catch (error) {
      failedAny = true;
      result.failed.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (removedAny) result.profiles.push(accountDir);
}

export type LegacyBrowserProfileCleanupSchedule = LegacyBrowserProfileCleanupOptions & {
  startDelayMs: number;
  retryMs: number;
  log: (message: string, details: Record<string, unknown>) => void;
};

/**
 * Runs the cleanup once, off the daemon's start-up path, and again later while a sign-in was in
 * progress or a removal failed. Stops for good after a pass that finished.
 */
export function scheduleLegacyBrowserProfileCleanup(
  schedule: LegacyBrowserProfileCleanupSchedule,
): {
  stop: () => void;
} {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const next = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void pruneLegacyBrowserProfiles(schedule)
        .then((result) => {
          if (result.profiles.length > 0 || result.failed.length > 0) {
            schedule.log("removed old sign-in browser profiles", {
              profiles: result.profiles,
              removedEntries: result.removedEntries,
              removedBytes: result.removedBytes,
              failed: result.failed,
            });
          }
          if (result.skipped === "sign_in_active" || result.failed.length > 0) {
            next(schedule.retryMs);
          }
        })
        .catch((error) => {
          schedule.log("old sign-in browser profile cleanup failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          next(schedule.retryMs);
        });
    }, delayMs);
    timer.unref?.();
  };
  next(schedule.startDelayMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
