import { createLogger } from "../../core/logging.js";
import type { CuedDatabase } from "../../db/database.js";
import type { DbWorker } from "../../db/db-worker.js";
import type { DaemonBootstrapSnapshot } from "../status.js";
import {
  DAEMON_STATUS_BUSY_TIMEOUT_MS,
  FTS_INDEX_PASS_BUDGET_MS,
  FTS_INDEX_SLICE_GAP_MS,
  FTS_INDEXING_STALE_AFTER_MS,
  FTS_PROJECTION_THROTTLE_BACKLOG_EVENTS,
  FTS_PROJECTION_THROTTLE_DELAY_MS,
  isSqliteBusyError,
  now,
  QUEUE_DRAIN_RETRY_DELAY_MS,
} from "./settings.js";
import type { StallMonitor } from "./stall-monitor.js";

const daemonLogger = createLogger("daemon");

/** What the search-index drain reads from the daemon that runs it. */
export type SearchIndexDrainDeps = {
  db: CuedDatabase;
  dbWorker: DbWorker;
  stallMonitor: StallMonitor;
  bootstrap: DaemonBootstrapSnapshot;
  isUpdateShutdownRequested: () => boolean;
  isShutdownInitiated: () => boolean;
  isProcessingProjection: () => boolean;
  requestMenuBarStatusWrite: (reason: string) => void;
};

/**
 * Indexes messages for search on the database worker, one budgeted pass at a time, once
 * bootstrap is done and no projection is running or pending.
 */
export function createSearchIndexDrain(deps: SearchIndexDrainDeps) {
  const {
    db,
    dbWorker,
    stallMonitor,
    bootstrap,
    isUpdateShutdownRequested,
    isShutdownInitiated,
    isProcessingProjection,
    requestMenuBarStatusWrite,
  } = deps;
  let isProcessingSearchIndex = false;
  let searchIndexWakePending = false;
  let searchIndexDrainScheduled = false;
  let searchIndexDrainTimer: NodeJS.Timeout | null = null;
  let searchIndexDrainDueAt: number | null = null;

  let searchIndexPass = { claimed: 0, indexed: 0, failed: 0, swept: 0 };
  const drainSearchIndexQueue = () => {
    searchIndexDrainScheduled = false;
    searchIndexDrainDueAt = null;
    if (isUpdateShutdownRequested()) {
      return;
    }
    if (isProcessingSearchIndex) {
      // The pass running on the worker may already have looked at the queues and be about to
      // report them empty. Remember this wake-up, or what was queued meanwhile would wait for
      // the next unrelated one.
      searchIndexWakePending = true;
      return;
    }
    if (isProcessingProjection()) {
      scheduleSearchIndexDrain(FTS_PROJECTION_THROTTLE_DELAY_MS);
      return;
    }
    if (bootstrap.state !== "ready") {
      scheduleSearchIndexDrain(QUEUE_DRAIN_RETRY_DELAY_MS);
      return;
    }
    let projectionBacklog: ReturnType<typeof db.getProjectionBacklog>;
    try {
      projectionBacklog = db.withBusyTimeoutSync(DAEMON_STATUS_BUSY_TIMEOUT_MS, () =>
        db.getProjectionBacklog(),
      );
    } catch (error) {
      if (!isSqliteBusyError(error)) {
        throw error;
      }
      daemonLogger.warn("message FTS index drain skipped because SQLite is busy");
      scheduleSearchIndexDrain(QUEUE_DRAIN_RETRY_DELAY_MS);
      return;
    }
    if (projectionBacklog.pending_raw_events > FTS_PROJECTION_THROTTLE_BACKLOG_EVENTS) {
      scheduleSearchIndexDrain(FTS_PROJECTION_THROTTLE_DELAY_MS);
      return;
    }
    isProcessingSearchIndex = true;
    void dbWorker
      .run("indexMessageSearch", {
        budgetMs: FTS_INDEX_PASS_BUDGET_MS,
        staleBefore: Date.now() - FTS_INDEXING_STALE_AFTER_MS,
      })
      .then((pass) => {
        searchIndexPass.claimed += pass.claimed;
        searchIndexPass.indexed += pass.indexed;
        searchIndexPass.failed += pass.failed;
        searchIndexPass.swept += pass.swept;
        if (pass.drained) {
          if (searchIndexPass.claimed > 0 || searchIndexPass.swept > 0) {
            daemonLogger.info("message FTS index backlog drained", { ...searchIndexPass });
            requestMenuBarStatusWrite("message_fts_index_completed");
          }
          searchIndexPass = { claimed: 0, indexed: 0, failed: 0, swept: 0 };
        } else {
          if (pass.claimed > 0 || pass.swept > 0) {
            requestMenuBarStatusWrite("message_fts_index_progress");
          }
          scheduleSearchIndexDrain(FTS_INDEX_SLICE_GAP_MS);
        }
      })
      .catch((error: unknown) => {
        if (isUpdateShutdownRequested() || isShutdownInitiated()) {
          return;
        }
        if (!isSqliteBusyError(error)) {
          daemonLogger.error("message FTS index batch failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        } else {
          daemonLogger.warn("message FTS index drain skipped because SQLite is busy");
        }
        scheduleSearchIndexDrain(QUEUE_DRAIN_RETRY_DELAY_MS);
      })
      .finally(() => {
        isProcessingSearchIndex = false;
        if (searchIndexWakePending) {
          searchIndexWakePending = false;
          scheduleSearchIndexDrain(FTS_INDEX_SLICE_GAP_MS);
        }
      });
  };

  const scheduleSearchIndexDrain = (delayMs = 0) => {
    const normalizedDelayMs = Math.max(0, delayMs);
    const dueAt = now() + normalizedDelayMs;
    if (searchIndexDrainScheduled) {
      if (searchIndexDrainDueAt != null && searchIndexDrainDueAt <= dueAt) {
        return;
      }
      if (searchIndexDrainTimer) {
        clearTimeout(searchIndexDrainTimer);
        searchIndexDrainTimer = null;
      }
    }
    searchIndexDrainScheduled = true;
    searchIndexDrainDueAt = dueAt;
    if (normalizedDelayMs <= 0) {
      setImmediate(drainSearchIndexQueue);
      return;
    }

    searchIndexDrainTimer = setTimeout(() => {
      searchIndexDrainTimer = null;
      stallMonitor.section("drain_search_index_queue", drainSearchIndexQueue);
    }, normalizedDelayMs);
  };

  const stopSearchIndexDrain = () => {
    if (searchIndexDrainTimer) {
      clearTimeout(searchIndexDrainTimer);
      searchIndexDrainTimer = null;
    }
  };

  return { scheduleSearchIndexDrain, stopSearchIndexDrain };
}
