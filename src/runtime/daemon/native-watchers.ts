import { type ChildProcess, spawn } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { basename, dirname } from "node:path";
import process from "node:process";
import { createLogger } from "../../core/logging.js";
import type { AdapterPlatform } from "../../core/types/provider.js";
import type { openCuedDatabase } from "../../db/database.js";
import { DEFAULT_CALL_HISTORY_DB_PATH } from "../../platforms/imessage/call-history.js";
import { DEFAULT_CHAT_DB_PATH } from "../../platforms/imessage/reader.js";
import { resolveMacOSNativeBinary } from "../native-binary.js";
import { createWatcherSyncTrigger } from "./local-watchers.js";
import {
  isSqliteBusyError,
  TIMER_JOB_BUSY_RETRY_MS,
  TIMER_JOB_BUSY_TIMEOUT_MS,
} from "./settings.js";

const daemonLogger = createLogger("daemon");
const nativeWatchLogger = createLogger("native-watch");

type NativeWatcherName = "contacts" | "imessage" | "callhistory";

/**
 * Queues a sync for a change reported outside the scheduler. Answers "busy" when a sync of
 * the account is already under way, since that run may have read before the change.
 */
function queueNativeTriggeredSync(
  db: ReturnType<typeof openCuedDatabase>,
  platform: AdapterPlatform,
  accountKey: string,
  trigger: string,
  wakeIngest: () => void,
): "taken" | "busy" {
  try {
    return db.withBusyTimeoutSync(TIMER_JOB_BUSY_TIMEOUT_MS, () => {
      const integration = db.getIntegrationState(platform, accountKey);
      if (!integration || integration.enabled !== 1 || integration.sync_capable !== 1) {
        return "taken";
      }
      if (db.hasQueuedOrRunningRun(platform, accountKey)) {
        // A history page waiting only because of battery power would hold this catch-up
        // back until its delay ran out.
        if (db.expeditePowerDeferredSyncRun(platform, accountKey, trigger)) {
          wakeIngest();
          return "taken";
        }
        return "busy";
      }

      db.queueSyncRun({
        platform,
        accountKey,
        runType: "sync",
        trigger,
        details: { source: platform, accountKey, trigger },
      });
      wakeIngest();
      return "taken";
    });
  } catch (error) {
    if (!isSqliteBusyError(error)) {
      throw error;
    }
    daemonLogger.warn("native-triggered sync queue deferred because SQLite is busy", {
      platform,
      accountKey,
      trigger,
    });
    setTimeout(() => {
      queueNativeTriggeredSync(db, platform, accountKey, trigger, wakeIngest);
    }, TIMER_JOB_BUSY_RETRY_MS);
    return "taken";
  }
}

function createDebouncedSyncEnqueuer(
  db: ReturnType<typeof openCuedDatabase>,
  wakeIngest: () => void,
): (platform: AdapterPlatform, accountKey: string, trigger: string) => void {
  const trigger = createWatcherSyncTrigger();
  return (platform, accountKey, reason) =>
    trigger(`${platform}:${accountKey}`, () =>
      queueNativeTriggeredSync(db, platform, accountKey, reason, wakeIngest),
    );
}

function startIMessageWatcher(
  _db: ReturnType<typeof openCuedDatabase>,
  queueSync: (platform: AdapterPlatform, accountKey: string, trigger: string) => void,
): FSWatcher | ChildProcess | null {
  // The database the iMessage worker reads.
  const dbPath = process.env.CUED_IMESSAGE_DB_PATH || DEFAULT_CHAT_DB_PATH;
  const nativeBinary = resolveMacOSNativeBinary(process.env.CUED_IMESSAGE_NATIVE_BINARY);
  if (nativeBinary) {
    const child = spawn(nativeBinary, ["imessage", "watch", "--db-path", dbPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdoutBuffer = "";
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          queueSync("imessage", "local", "native_watch:imessage");
        }
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message.length > 0) {
        nativeWatchLogger.warn(`imessage watcher stderr`, { message });
      }
    });

    child.on("error", (error) => {
      nativeWatchLogger.warn("imessage watcher failed", error);
    });

    return child;
  }

  try {
    const targetDir = dirname(dbPath);
    const watchedNames = new Set([
      basename(dbPath),
      `${basename(dbPath)}-wal`,
      `${basename(dbPath)}-shm`,
    ]);

    return watch(targetDir, (_eventType, filename) => {
      if (!filename) {
        return;
      }
      if (!watchedNames.has(filename.toString())) {
        return;
      }
      queueSync("imessage", "local", "native_watch:imessage");
    });
  } catch (error) {
    nativeWatchLogger.warn("imessage watcher unavailable", error);
    return null;
  }
}

function startCallHistoryWatcher(
  _db: ReturnType<typeof openCuedDatabase>,
  queueSync: (platform: AdapterPlatform, accountKey: string, trigger: string) => void,
): FSWatcher | ChildProcess | null {
  const nativeBinary = resolveMacOSNativeBinary(process.env.CUED_IMESSAGE_NATIVE_BINARY);
  const dbPath = process.env.CUED_CALL_HISTORY_DB_PATH || DEFAULT_CALL_HISTORY_DB_PATH;
  if (nativeBinary) {
    const child = spawn(nativeBinary, ["callhistory", "watch", "--db-path", dbPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdoutBuffer = "";
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          queueSync("imessage", "local", "native_watch:callhistory");
        }
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message.length > 0) {
        nativeWatchLogger.warn("callhistory watcher stderr", { message });
      }
    });

    child.on("error", (error) => {
      nativeWatchLogger.warn("callhistory watcher failed", error);
    });

    return child;
  }

  try {
    const targetDir = dirname(dbPath);
    const watchedNames = new Set([
      basename(dbPath),
      `${basename(dbPath)}-wal`,
      `${basename(dbPath)}-shm`,
    ]);

    return watch(targetDir, (_eventType, filename) => {
      if (!filename) {
        return;
      }
      if (!watchedNames.has(filename.toString())) {
        return;
      }
      queueSync("imessage", "local", "native_watch:callhistory");
    });
  } catch (error) {
    nativeWatchLogger.warn("callhistory watcher unavailable", error);
    return null;
  }
}

function startContactsWatcher(
  _db: ReturnType<typeof openCuedDatabase>,
  queueSync: (platform: AdapterPlatform, accountKey: string, trigger: string) => void,
): ChildProcess | null {
  const nativeBinary = resolveMacOSNativeBinary(process.env.CUED_CONTACTS_NATIVE_BINARY);
  if (!nativeBinary) {
    return null;
  }

  const child = spawn(nativeBinary, ["contacts", "watch"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  let stdoutBuffer = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        queueSync("contacts", "local", "native_watch:contacts");
      }
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });

  child.stderr.on("data", (chunk) => {
    const message = chunk.toString("utf8").trim();
    if (message.length > 0) {
      nativeWatchLogger.warn("contacts watcher stderr", { message });
    }
  });

  child.on("error", (error) => {
    nativeWatchLogger.warn("contacts watcher failed", error);
  });

  return child;
}

export {
  createDebouncedSyncEnqueuer,
  queueNativeTriggeredSync,
  startCallHistoryWatcher,
  startContactsWatcher,
  startIMessageWatcher,
  type NativeWatcherName,
};
