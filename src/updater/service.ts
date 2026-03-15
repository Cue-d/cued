import { execFileSync, spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";
import { getCurrentAppVersion, getCurrentReleaseChannel } from "../app-metadata.js";
import { sendDaemonRequest } from "../client.js";
import {
  CUED_BACKUPS_DIR,
  CUED_DB_PATH,
  CUED_SOCKET_PATH,
  CUED_UPDATE_DOWNLOADS_DIR,
  CUED_UPDATE_ROLLBACK_DIR,
  ensureCuedDirs,
} from "../config.js";
import { type CuedDatabase, openCuedDatabase } from "../db/database.js";
import { createLogger } from "../logging.js";
import { terminateCompetingDaemons } from "../macos/competing-daemons.js";
import {
  bootoutLaunchAgent,
  getAppBundleVersion,
  getAppExecutablePath,
  getCLISymlinkPath,
  getCurrentAppPath,
  getLaunchAgentPlistPath,
  isValidCuedAppBundle,
  resolveInstalledAppPath,
} from "../macos/install.js";
import type {
  PendingRollbackState,
  UpdateErrorState,
  UpdateReleaseState,
  UpdateStatusSnapshot,
} from "./types.js";

const updaterLogger = createLogger("updater");
const RELEASE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RELEASE_REPO = process.env.CUED_RELEASE_REPO ?? "Cue-d/cued";
const RELEASE_API_BASE = process.env.CUED_RELEASE_API_BASE ?? "https://api.github.com";
const RELEASE_ASSET_NAME = "cued-macos-arm64.tar.gz";
const UPDATE_SHUTDOWN_TIMEOUT_MS = 45_000;
const UPDATE_HEALTH_TIMEOUT_MS = 90_000;
const UPDATE_HELPER_WAIT_FOR_EXIT_MS = 30_000;

type GitHubReleaseAsset = {
  name?: unknown;
  browser_download_url?: unknown;
};

type GitHubRelease = {
  tag_name?: unknown;
  prerelease?: unknown;
  html_url?: unknown;
  assets?: unknown;
};

interface ReleaseCandidate {
  version: string;
  prerelease: boolean;
  releaseUrl: string | null;
  tarballUrl: string | null;
}

type CheckOptions = {
  force?: boolean;
  fetchImpl?: typeof fetch;
};

type DownloadedRelease = {
  version: string;
  releaseUrl: string | null;
  tarballUrl: string;
  archivePath: string;
  stagingDir: string;
  stagedAppPath: string;
};

type InstallResult = {
  started: boolean;
  targetVersion: string;
  releaseUrl: string | null;
  installedAppPath: string;
};

function now(): number {
  return Date.now();
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/, "");
}

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
} | null;

function parseSemver(value: string): ParsedSemver {
  const match = normalizeVersion(value).match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/,
  );
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const leftIsNumber = Number.isInteger(leftNumber) && String(leftNumber) === left;
  const rightIsNumber = Number.isInteger(rightNumber) && String(rightNumber) === right;

  if (leftIsNumber && rightIsNumber) {
    return leftNumber - rightNumber;
  }

  if (leftIsNumber) {
    return -1;
  }

  if (rightIsNumber) {
    return 1;
  }

  return left.localeCompare(right);
}

export function compareVersions(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);

  if (!parsedLeft || !parsedRight) {
    return normalizeVersion(left).localeCompare(normalizeVersion(right));
  }

  if (parsedLeft.major !== parsedRight.major) {
    return parsedLeft.major - parsedRight.major;
  }
  if (parsedLeft.minor !== parsedRight.minor) {
    return parsedLeft.minor - parsedRight.minor;
  }
  if (parsedLeft.patch !== parsedRight.patch) {
    return parsedLeft.patch - parsedRight.patch;
  }

  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length === 0) {
    return 0;
  }
  if (parsedLeft.prerelease.length === 0) {
    return 1;
  }
  if (parsedRight.prerelease.length === 0) {
    return -1;
  }

  for (
    let index = 0;
    index < Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
    index += 1
  ) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier == null) {
      return -1;
    }
    if (rightIdentifier == null) {
      return 1;
    }
    const comparison = compareIdentifiers(leftIdentifier, rightIdentifier);
    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}

export function pickReleaseForChannel(
  releases: GitHubRelease[],
  channel: string,
): ReleaseCandidate | null {
  if (channel === "dev") {
    return null;
  }

  const wantsPrerelease = channel !== "stable";
  for (const entry of releases) {
    const version = typeof entry.tag_name === "string" ? normalizeVersion(entry.tag_name) : null;
    const prerelease = Boolean(entry.prerelease);
    if (!version || prerelease !== wantsPrerelease) {
      continue;
    }

    const assets = Array.isArray(entry.assets) ? (entry.assets as GitHubReleaseAsset[]) : [];
    const tarballUrl =
      assets.find((asset) => asset.name === RELEASE_ASSET_NAME)?.browser_download_url ?? null;
    if (typeof tarballUrl !== "string" || tarballUrl.length === 0) {
      continue;
    }

    return {
      version,
      prerelease,
      releaseUrl: typeof entry.html_url === "string" ? entry.html_url : null,
      tarballUrl,
    };
  }

  return null;
}

export function isUpdateCheckDue(
  lastCheckedAt: number | null,
  at = now(),
  intervalMs = RELEASE_CHECK_INTERVAL_MS,
): boolean {
  if (!Number.isFinite(lastCheckedAt ?? Number.NaN)) {
    return true;
  }
  return at - Number(lastCheckedAt) >= intervalMs;
}

function toUpdateStatus(
  releaseState: UpdateReleaseState | null,
  db: CuedDatabase,
): UpdateStatusSnapshot {
  const cached = db.getUpdateStatus();
  if (!releaseState) {
    return cached;
  }
  return {
    ...cached,
    lastCheckedAt: releaseState.checkedAt,
    latestVersion: releaseState.latestVersion,
    availableVersion: releaseState.availableVersion,
    available: Boolean(releaseState.availableVersion),
    releaseUrl: releaseState.releaseUrl,
    tarballUrl: releaseState.tarballUrl,
  };
}

function setUpdateError(
  db: CuedDatabase,
  stage: string,
  message: string,
  targetVersion: string | null,
): UpdateErrorState {
  const errorState: UpdateErrorState = {
    at: now(),
    stage,
    message,
    targetVersion,
  };
  db.setUpdateLastError(errorState);
  return errorState;
}

async function fetchReleases(
  db: CuedDatabase,
  fetchImpl: typeof fetch,
): Promise<{ releases: GitHubRelease[] | null; etag: string | null; notModified: boolean }> {
  const cached = db.getUpdateReleaseState();
  const headers = new Headers({
    Accept: "application/vnd.github+json",
  });
  if (cached?.etag) {
    headers.set("If-None-Match", cached.etag);
  }

  const response = await fetchImpl(`${RELEASE_API_BASE}/repos/${RELEASE_REPO}/releases`, {
    headers,
  });

  if (response.status === 304) {
    return {
      releases: null,
      etag: cached?.etag ?? null,
      notModified: true,
    };
  }

  if (!response.ok) {
    throw new Error(`Release check failed with ${response.status}`);
  }

  const parsed = (await response.json()) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Release check returned an unexpected payload");
  }

  return {
    releases: parsed as GitHubRelease[],
    etag: response.headers.get("etag"),
    notModified: false,
  };
}

export async function checkForUpdates(
  db: CuedDatabase,
  options: CheckOptions = {},
): Promise<UpdateStatusSnapshot> {
  const channel = getCurrentReleaseChannel();
  const currentVersion = getCurrentAppVersion();
  const cached = db.getUpdateReleaseState();
  const force = options.force ?? false;

  if (!force && !isUpdateCheckDue(cached?.checkedAt ?? null)) {
    return db.getUpdateStatus();
  }

  if (channel === "dev") {
    const releaseState: UpdateReleaseState = {
      checkedAt: now(),
      channel,
      currentVersion,
      latestVersion: currentVersion,
      availableVersion: null,
      releaseUrl: null,
      tarballUrl: null,
      etag: cached?.etag ?? null,
    };
    db.setUpdateReleaseState(releaseState);
    db.setUpdateLastError(null);
    return toUpdateStatus(releaseState, db);
  }

  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const { releases, etag, notModified } = await fetchReleases(db, fetchImpl);
    const selected = notModified
      ? cached
        ? {
            version: cached.latestVersion ?? cached.currentVersion,
            prerelease: channel !== "stable",
            releaseUrl: cached.releaseUrl,
            tarballUrl: cached.tarballUrl,
          }
        : null
      : pickReleaseForChannel(releases ?? [], channel);

    const latestVersion = selected?.version ?? null;
    const availableVersion =
      latestVersion && compareVersions(latestVersion, currentVersion) > 0 ? latestVersion : null;

    const releaseState: UpdateReleaseState = {
      checkedAt: now(),
      channel,
      currentVersion,
      latestVersion,
      availableVersion,
      releaseUrl: selected?.releaseUrl ?? null,
      tarballUrl: selected?.tarballUrl ?? null,
      etag: etag ?? cached?.etag ?? null,
    };
    db.setUpdateReleaseState(releaseState);
    db.setUpdateLastError(null);
    updaterLogger.info("release check completed", {
      latestVersion,
      availableVersion,
      channel,
    });
    return toUpdateStatus(releaseState, db);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updaterLogger.warn("release check failed", { error: message });
    setUpdateError(db, "check", message, null);
    return db.getUpdateStatus();
  }
}

async function downloadReleaseAsset(url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/octet-stream",
    },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed with ${response.status}`);
  }
  mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${destinationPath}.download`;
  rmSync(temporaryPath, { force: true });
  const stream = createWriteStream(temporaryPath, { mode: 0o600 });
  try {
    await pipeline(Readable.fromWeb(response.body), stream);
    renameSync(temporaryPath, destinationPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function validateBundleSignature(appPath: string): void {
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "ignore" });
  execFileSync("spctl", ["--assess", "--type", "execute", appPath], { stdio: "ignore" });
}

function waitForDaemonExit(db: CuedDatabase, timeoutMs: number): void {
  const startedAt = now();
  while (now() - startedAt < timeoutMs) {
    const daemon = db.getDaemonState();
    const pidRunning =
      typeof daemon?.pid === "number" && daemon.pid > 0 ? isProcessRunning(daemon.pid) : false;
    if (!existsSync(CUED_SOCKET_PATH) && !pidRunning) {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error("Timed out waiting for daemon shutdown");
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function requestShutdownForUpdate(db: CuedDatabase): Promise<void> {
  if (existsSync(CUED_SOCKET_PATH)) {
    const response = await sendDaemonRequest({ command: "shutdown-for-update" });
    if (!response.ok) {
      throw new Error(response.error ?? "Daemon shutdown for update failed");
    }
  } else {
    const daemon = db.getDaemonState();
    if (typeof daemon?.pid === "number" && daemon.pid > 0) {
      try {
        process.kill(daemon.pid, "SIGTERM");
      } catch {
        // Ignore stale PID state and rely on the wait loop below.
      }
    }
  }

  waitForDaemonExit(db, UPDATE_SHUTDOWN_TIMEOUT_MS);
}

function backupDatabaseSnapshot(sourceDbPath: string, destinationPath: string): void {
  const backupDb = new Database(sourceDbPath);
  try {
    rmSync(destinationPath, { force: true });
    backupDb.pragma("wal_checkpoint(FULL)");
    backupDb.exec(`VACUUM INTO ${sqlString(destinationPath)}`);
  } finally {
    backupDb.close();
  }
}

function runPreflight(stagedAppPath: string, preflightDbPath: string): void {
  const cliPath = join(stagedAppPath, "Contents", "Resources", "cued-cli");
  execFileSync(cliPath, ["update", "preflight", "--db-path", preflightDbPath], {
    env: {
      ...process.env,
      CUED_APP_PATH: stagedAppPath,
    },
    stdio: "ignore",
  });
}

async function prepareReleaseInstall(db: CuedDatabase): Promise<DownloadedRelease> {
  const status = await checkForUpdates(db, { force: true });
  if (!status.available || !status.availableVersion || !status.tarballUrl) {
    throw new Error("No newer update is available");
  }

  const downloadDir = join(CUED_UPDATE_DOWNLOADS_DIR, status.availableVersion);
  const archivePath = join(downloadDir, RELEASE_ASSET_NAME);
  const stagingDir = mkdtempSync(join(tmpdir(), "cued-update-stage."));
  const extractDir = join(stagingDir, "staging");
  const stagedAppPath = join(extractDir, "Cued.app");

  mkdirSync(downloadDir, { recursive: true, mode: 0o700 });
  if (!existsSync(archivePath)) {
    await downloadReleaseAsset(status.tarballUrl, archivePath);
  }
  mkdirSync(extractDir, { recursive: true, mode: 0o700 });
  execFileSync("tar", ["-xzf", archivePath, "-C", extractDir], { stdio: "ignore" });

  if (!isValidCuedAppBundle(stagedAppPath)) {
    throw new Error("Downloaded update is not a valid Cued app bundle");
  }
  const stagedVersion = getAppBundleVersion(stagedAppPath);
  if (stagedVersion !== status.availableVersion) {
    throw new Error(
      `Downloaded update version mismatch: expected ${status.availableVersion}, got ${stagedVersion ?? "unknown"}`,
    );
  }
  validateBundleSignature(stagedAppPath);

  return {
    version: status.availableVersion,
    releaseUrl: status.releaseUrl,
    tarballUrl: status.tarballUrl,
    archivePath,
    stagingDir,
    stagedAppPath,
  };
}

function assertInstalledContext(): { currentAppPath: string; installedAppPath: string } {
  const currentAppPath = getCurrentAppPath();
  const installedAppPath = resolveInstalledAppPath();
  if (!currentAppPath || !installedAppPath) {
    throw new Error("Updates require running from an installed Cued.app bundle");
  }
  if (realpathSync(currentAppPath) !== realpathSync(installedAppPath)) {
    throw new Error("Updates must be initiated from the installed Cued.app bundle");
  }
  return { currentAppPath, installedAppPath };
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function writeHelperScript(
  input: PendingRollbackState & {
    stagedAppPath: string;
    targetVersion: string;
    dbPath: string;
    stagingRoot: string;
  },
): string {
  const helperDir = mkdtempSync(join(tmpdir(), "cued-update-helper."));
  const scriptPath = join(helperDir, "apply-update.sh");
  const script = `#!/usr/bin/env bash
set -euo pipefail

INSTALLED_APP_PATH=${shellEscape(input.installedAppPath)}
INSTALLED_APP_EXEC=${shellEscape(getAppExecutablePath(input.installedAppPath))}
STAGED_APP_PATH=${shellEscape(input.stagedAppPath)}
APP_BACKUP_PATH=${shellEscape(input.appBackupPath)}
DB_PATH=${shellEscape(input.dbPath)}
DB_BACKUP_PATH=${shellEscape(input.dbBackupPath)}
CLI_SYMLINK_PATH=${shellEscape(getCLISymlinkPath())}
LAUNCH_AGENT_PLIST=${shellEscape(getLaunchAgentPlistPath())}
TARGET_VERSION=${shellEscape(input.targetVersion)}
STAGING_ROOT=${shellEscape(input.stagingRoot)}
WAIT_FOR_EXIT_MS=${UPDATE_HELPER_WAIT_FOR_EXIT_MS}
HEALTH_TIMEOUT_MS=${UPDATE_HEALTH_TIMEOUT_MS}

sqlite_exec() {
  /usr/bin/sqlite3 "$DB_PATH" "$1" >/dev/null
}

clear_pending() {
  sqlite_exec "INSERT INTO app_settings (key, value, updated_at) VALUES ('update_pending_rollback_json', NULL, strftime('%s','now') * 1000) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;"
}

wait_for_old_app_exit() {
  local deadline=$(( $(date +%s) * 1000 + WAIT_FOR_EXIT_MS ))
  while /usr/bin/pgrep -f "$INSTALLED_APP_EXEC" >/dev/null 2>&1; do
    if (( $(date +%s) * 1000 >= deadline )); then
      /usr/bin/pkill -TERM -f "$INSTALLED_APP_EXEC" >/dev/null 2>&1 || true
      sleep 2
      break
    fi
    sleep 1
  done
}

restore_previous() {
  /usr/bin/pkill -TERM -f "$INSTALLED_APP_EXEC" >/dev/null 2>&1 || true
  sleep 2
  mkdir -p "$INSTALLED_APP_PATH"
  /usr/bin/rsync -a --delete "$APP_BACKUP_PATH/" "$INSTALLED_APP_PATH/"
  cp "$DB_BACKUP_PATH" "$DB_PATH"
  rm -f "$DB_PATH-wal" "$DB_PATH-shm"
  if [[ -f "$LAUNCH_AGENT_PLIST" ]]; then
    /bin/launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT_PLIST" >/dev/null 2>&1 || true
  fi
  /usr/bin/open "$INSTALLED_APP_PATH" >/dev/null 2>&1 || true
}

wait_for_health() {
  local deadline=$(( $(date +%s) * 1000 + HEALTH_TIMEOUT_MS ))
  while (( $(date +%s) * 1000 < deadline )); do
    if [[ -f "$DB_PATH" ]]; then
      local row
      row=$(/usr/bin/sqlite3 "$DB_PATH" "SELECT COALESCE(status,''), COALESCE(version,'') FROM daemon_state WHERE singleton_key = 'daemon' LIMIT 1;" 2>/dev/null || true)
      if [[ "$row" == "running|$TARGET_VERSION" || "$row" == "running$TARGET_VERSION" ]]; then
        return 0
      fi
      if [[ "$row" == "running|$TARGET_VERSION"* ]]; then
        return 0
      fi
    fi
    sleep 2
  done
  return 1
}

wait_for_old_app_exit
mkdir -p "$INSTALLED_APP_PATH"
/usr/bin/rsync -a --delete "$STAGED_APP_PATH/" "$INSTALLED_APP_PATH/"
mkdir -p "$(dirname "$CLI_SYMLINK_PATH")"
ln -sf "$INSTALLED_APP_PATH/Contents/Resources/cued-cli" "$CLI_SYMLINK_PATH"
if [[ -f "$LAUNCH_AGENT_PLIST" ]]; then
  /bin/launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT_PLIST" >/dev/null 2>&1 || true
fi
/usr/bin/open "$INSTALLED_APP_PATH" >/dev/null 2>&1 || true

if wait_for_health; then
  clear_pending
  sqlite_exec "INSERT INTO app_settings (key, value, updated_at) VALUES ('update_last_error_json', NULL, strftime('%s','now') * 1000) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;"
  rm -rf "$STAGING_ROOT"
  exit 0
fi

restore_previous
clear_pending
sqlite_exec "INSERT INTO app_settings (key, value, updated_at) VALUES ('update_last_error_json', 'Update health check failed; restored previous version.', strftime('%s','now') * 1000) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;"
rm -rf "$STAGING_ROOT"
exit 1
`;
  writeFileSync(scriptPath, script, { mode: 0o700 });
  return scriptPath;
}

function spawnUpdateHelper(
  pendingRollback: PendingRollbackState,
  stagedAppPath: string,
  dbPath: string,
): void {
  const scriptPath = writeHelperScript({
    ...pendingRollback,
    stagedAppPath,
    targetVersion: pendingRollback.targetVersion,
    dbPath,
    stagingRoot: dirname(dirname(stagedAppPath)),
  });
  const child = spawn("/bin/bash", [scriptPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export async function installAvailableUpdate(db: CuedDatabase): Promise<InstallResult> {
  ensureCuedDirs();
  const { installedAppPath } = assertInstalledContext();
  const prepared = await prepareReleaseInstall(db);

  try {
    db.setUpdateLastError(null);
    await requestShutdownForUpdate(db);
    bootoutLaunchAgent();
    terminateCompetingDaemons({
      expectedExecutablePath: getAppExecutablePath(installedAppPath),
    });

    const currentVersion = getCurrentAppVersion();
    const backupStamp = `${now()}-preupdate-${currentVersion}-to-${prepared.version}`;
    const rollbackDir = join(CUED_UPDATE_ROLLBACK_DIR, backupStamp);
    const appBackupPath = join(rollbackDir, "Cued.app");
    const dbBackupPath = join(CUED_BACKUPS_DIR, `${backupStamp}.db`);
    const preflightDbPath = join(rollbackDir, "preflight.db");

    mkdirSync(rollbackDir, { recursive: true, mode: 0o700 });
    mkdirSync(appBackupPath, { recursive: true, mode: 0o700 });
    execFileSync("rsync", ["-a", "--delete", `${installedAppPath}/`, `${appBackupPath}/`], {
      stdio: "ignore",
    });
    backupDatabaseSnapshot(CUED_DB_PATH, dbBackupPath);
    backupDatabaseSnapshot(CUED_DB_PATH, preflightDbPath);
    runPreflight(prepared.stagedAppPath, preflightDbPath);

    const pendingRollback: PendingRollbackState = {
      startedAt: now(),
      previousVersion: currentVersion,
      targetVersion: prepared.version,
      installedAppPath,
      appBackupPath,
      dbBackupPath,
      releaseUrl: prepared.releaseUrl,
    };
    db.setUpdatePendingRollback(pendingRollback);

    spawnUpdateHelper(pendingRollback, prepared.stagedAppPath, CUED_DB_PATH);
    updaterLogger.info("update helper spawned", {
      targetVersion: prepared.version,
      installedAppPath,
    });
    return {
      started: true,
      targetVersion: prepared.version,
      releaseUrl: prepared.releaseUrl,
      installedAppPath,
    };
  } catch (error) {
    db.setUpdatePendingRollback(null);
    const message = error instanceof Error ? error.message : String(error);
    setUpdateError(db, "install", message, prepared.version);
    throw error;
  }
}

export function runUpdatePreflight(dbPath: string): Record<string, unknown> {
  const db = openCuedDatabase(dbPath);
  try {
    return {
      ok: true,
      dbPath,
      version: getCurrentAppVersion(),
      overview: db.getOverview(),
    };
  } finally {
    db.close();
  }
}

export function getUpdateStatus(db: CuedDatabase): UpdateStatusSnapshot {
  return db.getUpdateStatus();
}
