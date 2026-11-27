import process from "node:process";
import { getCurrentAppVersion, getCurrentReleaseChannel } from "../../core/app-metadata.js";
import { CUED_SOCKET_PATH } from "../../core/config.js";
import type { HostOS } from "../../core/types/provider.js";
import type { CuedDatabase } from "../../db/database.js";
import type { StatusAggregates } from "../../db/db-worker-jobs.js";
import { readMenuBarStatusCache, writeMenuBarStatusCache } from "../menu-bar-status-cache.js";
import {
  buildMenuBarDaemonStatusSnapshot,
  type DaemonBootstrapSnapshot,
  type RealtimeSessionStatuses,
  realtimeSessionFields,
} from "../status.js";
import { now } from "./settings.js";

const DAEMON_VERSION = getCurrentAppVersion();

function getAppStatusMetadata(db: { getAppMetadata: () => unknown }): {
  hostOs: HostOS;
  version: string;
  releaseChannel: string;
  install: unknown;
} {
  return {
    hostOs:
      process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
    version: DAEMON_VERSION,
    releaseChannel: getCurrentReleaseChannel(),
    install: db.getAppMetadata(),
  };
}

function getFallbackAppStatusMetadata(): {
  hostOs: HostOS;
  version: string;
  releaseChannel: string;
  install: null;
} {
  return {
    hostOs:
      process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
    version: DAEMON_VERSION,
    releaseChannel: getCurrentReleaseChannel(),
    install: null,
  };
}

function writeMenuBarStatusSnapshot(
  db: CuedDatabase,
  options: {
    realtime: RealtimeSessionStatuses;
    bootstrap: DaemonBootstrapSnapshot;
    aggregates: StatusAggregates;
  },
): void {
  const snapshot = buildMenuBarDaemonStatusSnapshot(db, {
    app: getAppStatusMetadata(db),
    realtime: options.realtime,
    socketPath: CUED_SOCKET_PATH,
    bootstrap: options.bootstrap,
    aggregates: options.aggregates,
  });
  writeMenuBarStatusCache(snapshot);
}

function readCachedDaemonStatusSnapshot(options?: {
  maxAgeMs?: number;
}): Record<string, unknown> | null {
  return readMenuBarStatusCache(options)?.snapshot ?? null;
}

function getDaemonIdentity(): {
  executablePath: string;
  appPath?: string;
} {
  const appPath = process.env.CUED_APP_PATH?.trim() || undefined;
  return {
    executablePath: process.execPath,
    appPath,
  };
}

function buildDaemonBusyStatusSnapshot(options: {
  realtime: RealtimeSessionStatuses;
  socketPath: string;
  bootstrap: DaemonBootstrapSnapshot;
  dbPath: string;
  error: unknown;
}) {
  return {
    app: getFallbackAppStatusMetadata(),
    bootstrap: options.bootstrap,
    daemon: {
      pid: process.pid,
      started_at: null,
      updated_at: now(),
      status: "running",
      version: DAEMON_VERSION,
      details_json: JSON.stringify(getDaemonIdentity()),
    },
    daemonDbBusy: true,
    daemonDbBusyError:
      options.error instanceof Error ? options.error.message : String(options.error),
    overview: null,
    projection: null,
    checkpoints: [],
    recentRuns: [],
    ...realtimeSessionFields(options.realtime),
    integrations: [],
    socketPath: options.socketPath,
    dbPath: options.dbPath,
  };
}

export {
  buildDaemonBusyStatusSnapshot,
  DAEMON_VERSION,
  getAppStatusMetadata,
  getDaemonIdentity,
  readCachedDaemonStatusSnapshot,
  writeMenuBarStatusSnapshot,
};
