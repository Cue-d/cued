import type { ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import process from "node:process";
import {
  CUED_BACKUPS_DIR,
  CUED_BROWSER_DIR,
  CUED_DAEMON_LOCK_PATH,
  CUED_DB_PATH,
  CUED_HOME,
  CUED_SOCKET_PATH,
  CUED_UPDATE_DOWNLOADS_DIR,
  CUED_UPDATE_ROLLBACK_DIR,
} from "../../core/config.js";
import { createLogger } from "../../core/logging.js";
import {
  acquireSingletonLock,
  SINGLETON_LOCK_HEARTBEAT_MS,
  SINGLETON_LOCK_STALE_MS,
  SingletonLockHeldError,
  type SingletonLockMetadata,
} from "../../core/singleton-lock.js";
import {
  readHostPowerState,
  readHostState,
  SleepInterruptionDetector,
  SyncInterruptedBySleep,
  shouldDeferSyncForSleep,
} from "../../core/system-sleep.js";
import {
  type AdapterPlatform,
  getDefaultAccountKeyForPlatform,
  isPlatform,
  type Platform,
} from "../../core/types/provider.js";
import { safeParseJsonRecord } from "../../db/codecs.js";
import { openCuedDatabase } from "../../db/database.js";
import {
  type DbWorker,
  InlineDbWorker,
  ResilientDbWorker,
  ThreadDbWorker,
} from "../../db/db-worker.js";
import { scheduleLegacyBrowserProfileCleanup } from "../../platforms/core/auth/legacy-browser-profiles.js";
import {
  buildAdapterInvocationEnv,
  selectAdapterInvocationProofs,
} from "../../platforms/core/invocation.js";
import { isAdapterPlatform } from "../../platforms/core/registry.js";
import { runAdapter } from "../../platforms/core/runner.js";
import { refreshLocalIntegrationStates } from "../../platforms/core/state/local-refresh.js";
import { invalidateIntegrationAuth } from "../../platforms/core/state/mutations.js";
import { refreshManagedIntegrationStates } from "../../platforms/core/state/refresh.js";
import { reconcileAbandonedAuthSessions } from "../../platforms/core/state/status.js";
import type { SyncContinuation } from "../../platforms/core/sync.js";
import { isDiscordAuthInvalidationError } from "../../platforms/discord/api/client.js";
import { warmSlackHelperInspection } from "../../platforms/slack/helper/binary.js";
import { warmWhatsAppHelperInspection } from "../../platforms/whatsapp/helper/pair.js";
import { buildWhatsAppRawEventsFromSnapshot } from "../../platforms/whatsapp/sync/events.js";
import {
  addWhatsAppResyncStats,
  buildWhatsAppMessagesProof,
  emptyWhatsAppResyncStats,
  mergeWhatsAppResyncCoverage,
  parseWhatsAppSourceCursor,
  selectWhatsAppHelperSinceMs,
  summarizeWhatsAppMessageCoverage,
} from "../../platforms/whatsapp/sync/proof.js";
import { durationBucket, errorTelemetryProperties } from "../../telemetry/context.js";
import { DaemonTelemetryQueue } from "../../telemetry/queue.js";
import type { DaemonEvent, DaemonEventTopic } from "../ipc.js";
import { collectInboundMessageHookPayloads } from "../message-hooks.js";
import { buildOnboardingSnapshot } from "../onboarding.js";
import { projectRealtimeRange } from "../projection/projector.js";
import {
  buildProjectionMessageHookBatches,
  ProjectionMessageHookBarrier,
  type ProjectionMessageHookPayload,
} from "../projection/service.js";
import { collectRealtimeSessionStatuses, type DaemonBootstrapSnapshot } from "../status.js";
import { pruneUpdateArtifacts, scheduleUpdateArtifactRetention } from "../updater/retention.js";
import { checkForUpdates } from "../updater/service.js";
import {
  getAutoSyncTargets,
  localSyncSourcesToRecheck,
  shouldSkipConnectedDiscordSchedulerSync,
} from "./auto-sync-targets.js";
import { safeEmitHookEvent } from "./hook-events.js";
import {
  IngestRunSupersededError,
  type IngestTiming,
  isAdapterAuthInvalidation,
  resolveCheckpointSyncMode,
} from "./ingest-run.js";
import { isNativeWatcherRunning, shouldBootstrapLocalIntegrations } from "./local-watchers.js";
import { SyncRunMaintenance } from "./maintenance.js";
import { createDebouncedSyncEnqueuer, createLocalWatchers } from "./native-watchers.js";
import { createProjectionRunner } from "./projection-runner.js";
import {
  getAdaptiveProjectionBatchSize,
  shouldDeferContinuationProjection,
  shouldProjectIngestRunInline,
} from "./projection-scheduling.js";
import {
  EMPTY_RAW_EVENT_INSERT_RESULT,
  insertRawEventsYielding,
  isInboundMessageEvent,
  mergeRawEventInsertResults,
  type RawEventInsertResult,
  summarizeRawEventsBySchema,
  withRawEventAcquisitionMode,
} from "./raw-events.js";
import { DaemonReadModel } from "./read-model.js";
import { createRealtimeIngest } from "./realtime-ingest.js";
import { blockDiscordIntegration } from "./realtime-sessions.js";
import { createRealtimeSupervisors } from "./realtime-supervisors.js";
import { type DaemonRequestContext, handleSocket } from "./request-handler.js";
import { createSearchIndexDrain } from "./search-index-drain.js";
import {
  DAEMON_STATUS_HEARTBEAT_MS,
  FOREGROUND_QUIET_PERIOD_MS,
  getAutoSyncIntervalMs,
  getAutoSyncProjectionBacklogPauseEvents,
  getAutoSyncSchedulerTickMs,
  getConfiguredRealtimePlatforms,
  getContinuationProjectionBacklogEvents,
  getContinuationProjectionIntervalMs,
  getDeferredProjectionCoalesceMs,
  getIngestConcurrency,
  getRealtimeProjectionBatchSize,
  getRealtimeProjectionEnabled,
  getSignalReconnectSyncCooldownMs,
  getSyncContinueDelayMsForPlatform,
  getWhatsAppResyncPageBudget,
  INGEST_RUN_LEASE_MS,
  isSqliteBusyError,
  LEGACY_BROWSER_PROFILE_CLEANUP_RETRY_MS,
  MENU_BAR_STATUS_EVENT_DEBOUNCE_MS,
  MENU_BAR_STATUS_EVENT_MIN_INTERVAL_MS,
  now,
  QUEUE_DRAIN_RETRY_DELAY_MS,
  TIMER_JOB_BUSY_RETRY_MS,
  TIMER_JOB_BUSY_TIMEOUT_MS,
  UPDATE_ARTIFACT_RETENTION_INTERVAL_MS,
  UPDATE_ARTIFACT_RETENTION_START_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_SHUTDOWN_GRACE_MS,
  WAL_BACKSTOP_AUTOCHECKPOINT_PAGES,
  WAL_CHECKPOINT_IDLE_POLL_MAX_MS,
  WAL_CHECKPOINT_MAX_INTERVAL_MS,
  WAL_CHECKPOINT_MIN_CHANGED_ROWS,
  WAL_CHECKPOINT_POLL_MS,
} from "./settings.js";
import { StallMonitor } from "./stall-monitor.js";
import {
  DAEMON_VERSION,
  getDaemonIdentity,
  writeMenuBarStatusSnapshot,
} from "./status-snapshot.js";
import {
  AutoSyncPacing,
  autoSyncPushPath,
  historyContinuationDelayMs,
  isScheduledSyncDue,
  SchedulerWakeDetector,
} from "./sync-pacing.js";
import { requestWhatsAppHistoryBackfillOnce } from "./whatsapp-sync.js";
import {
  BusyRetryingTimerJob,
  SQLITE_BUSY_SKIPPED,
  withoutWaitingForWriteLock,
} from "./write-lock.js";

const daemonLogger = createLogger("daemon");
const whatsAppLogger = createLogger("whatsapp");

export async function runDaemon(): Promise<void> {
  const daemonLease = await acquireDaemonLease();
  let openedDb: ReturnType<typeof openCuedDatabase> | null = null;
  try {
    await cleanupSocketPath();
    openedDb = openCuedDatabase();
  } catch (error) {
    daemonLease.release();
    openedDb?.close();
    throw error;
  }
  if (!openedDb) {
    daemonLease.release();
    throw new Error("Failed to open Cued database");
  }
  const db = openedDb;
  const positiveEnvNumber = (name: string) => {
    const configured = Number(process.env[name]);
    return Number.isFinite(configured) && configured > 0 ? configured : undefined;
  };
  const stallMonitor = new StallMonitor({
    onStall: (report) => daemonLogger.warn("event loop stalled", report),
    onSuspended: (report) => daemonLogger.info("event loop suspended", report),
    stallThresholdMs: positiveEnvNumber("CUED_STALL_THRESHOLD_MS"),
    slowSectionMs: positiveEnvNumber("CUED_STALL_SECTION_MS"),
    reportIntervalMs: positiveEnvNumber("CUED_STALL_REPORT_INTERVAL_MS"),
  });
  const telemetry = new DaemonTelemetryQueue(db);
  const startedAt = now();
  const runOwnerId = `daemon:${process.pid}:${startedAt}`;
  telemetry.enqueue("daemon_started", {
    component: "daemon",
    operation: "start",
  });
  const ingestConcurrency = getIngestConcurrency();
  const realtimeProjectionEnabled = getRealtimeProjectionEnabled();
  const realtimeProjectionBatchSize = getRealtimeProjectionBatchSize();
  const deferredProjectionCoalesceMs = getDeferredProjectionCoalesceMs();
  const autoSyncProjectionBacklogPauseEvents = getAutoSyncProjectionBacklogPauseEvents();
  const continuationProjectionIntervalMs = getContinuationProjectionIntervalMs();
  const continuationProjectionBacklogEvents = getContinuationProjectionBacklogEvents();
  const signalReconnectSyncCooldownMs = getSignalReconnectSyncCooldownMs();
  const configuredRealtimePlatforms = getConfiguredRealtimePlatforms();
  const shouldRunRealtimePlatform = (platform: AdapterPlatform): boolean =>
    configuredRealtimePlatforms == null || configuredRealtimePlatforms.has(platform);
  const activeAuthSessions = new Map<
    string,
    { child: ChildProcess; platform: Platform; accountKey: string }
  >();
  const activeIngestRuns = new Map<string, Promise<void>>();
  let ingestDrainScheduled = false;
  let ingestDrainTimer: NodeJS.Timeout | null = null;
  let ingestDrainDueAt: number | null = null;
  const lastAutoSyncQueuedAt = new Map<string, number>();
  const autoSyncPacing = new AutoSyncPacing();
  const lastContinuationProjectionQueuedAt = new Map<string, number>();
  const projectionMessageHooks = new ProjectionMessageHookBarrier();
  let updateCheckPromise: Promise<void> | null = null;
  let isUpdateShutdownRequested = false;
  let updateShutdownRequestedAt: number | null = null;
  let shutdownInitiated = false;
  const bootstrap: DaemonBootstrapSnapshot = {
    state: "starting",
    startedAt,
    finishedAt: null,
    error: null,
  };

  const queueMessageReceivedHooks = (
    range: { startRowId: number; endRowId: number } | null,
    inboundMessages: ProjectionMessageHookPayload[],
  ) => {
    if (!range || inboundMessages.length === 0) {
      return;
    }

    const batches = buildProjectionMessageHookBatches(
      range,
      inboundMessages,
      getAdaptiveProjectionBatchSize(db.getProjectionBacklog().pending_raw_events),
    );
    for (const batch of batches) {
      projectionMessageHooks.enqueue(batch, batch.payloads);
    }
  };

  const releaseMessageReceivedHooksForRange = async (range: {
    startRowId: number;
    endRowId: number;
  }) => {
    await projectionMessageHooks.releaseCompletedRange(range, async (payload) => {
      await safeEmitHookEvent("message.received", payload);
    });
  };

  const drainIngestQueue = () => {
    ingestDrainScheduled = false;
    ingestDrainDueAt = null;
    if (shouldDeferSyncForSleep()) {
      scheduleIngestDrain(10_000);
      return;
    }
    if (isUpdateShutdownRequested) {
      return;
    }
    if (isProcessingProjection()) {
      scheduleIngestDrain(QUEUE_DRAIN_RETRY_DELAY_MS);
      return;
    }
    const deferWhileBusy = () => {
      daemonLogger.warn("ingest drain deferred because SQLite is busy");
      scheduleIngestDrain(TIMER_JOB_BUSY_RETRY_MS);
    };
    if (activeIngestRuns.size === 0) {
      const nextProjectionRunAt = withoutWaitingForWriteLock(db, () =>
        db.getNextQueuedRunScheduledAt(["project", "rebuild"]),
      );
      if (nextProjectionRunAt === SQLITE_BUSY_SKIPPED) {
        deferWhileBusy();
        return;
      }
      if (nextProjectionRunAt != null && nextProjectionRunAt <= now()) {
        scheduleProjectionDrain();
        scheduleIngestDrain(QUEUE_DRAIN_RETRY_DELAY_MS);
        return;
      }
    }
    while (activeIngestRuns.size < ingestConcurrency) {
      const currentRun = withoutWaitingForWriteLock(db, () =>
        db.claimNextQueuedRun(["sync", "sync_resume"], "ingesting", {
          ownerId: runOwnerId,
          leaseMs: INGEST_RUN_LEASE_MS,
          excludedRunIds: [...activeIngestRuns.keys()],
        }),
      );
      if (currentRun === SQLITE_BUSY_SKIPPED) {
        deferWhileBusy();
        break;
      }
      if (!currentRun) {
        const nextClaimableAt = withoutWaitingForWriteLock(db, () =>
          db.getNextClaimableRunAt(["sync", "sync_resume"], "ingesting", [
            ...activeIngestRuns.keys(),
          ]),
        );
        if (nextClaimableAt === SQLITE_BUSY_SKIPPED) {
          deferWhileBusy();
        } else if (nextClaimableAt != null) {
          scheduleIngestDrain(Math.max(QUEUE_DRAIN_RETRY_DELAY_MS, nextClaimableAt - now()));
        }
        break;
      }

      requestMenuBarStatusWrite("ingest_started");
      const promise = processIngestRun(currentRun).finally(() => {
        activeIngestRuns.delete(currentRun.id);
        scheduleIngestDrain();
        scheduleProjectionDrain();
        maybeFinishUpdateShutdown();
      });
      activeIngestRuns.set(currentRun.id, promise);
    }
  };

  const scheduleIngestDrain = (delayMs = 0) => {
    const normalizedDelayMs = Math.max(0, delayMs);
    const dueAt = now() + normalizedDelayMs;
    if (ingestDrainScheduled) {
      if (ingestDrainDueAt != null && ingestDrainDueAt <= dueAt) {
        return;
      }
      if (ingestDrainTimer) {
        clearTimeout(ingestDrainTimer);
        ingestDrainTimer = null;
      }
    }
    ingestDrainScheduled = true;
    ingestDrainDueAt = dueAt;
    if (normalizedDelayMs <= 0) {
      setImmediate(drainIngestQueue);
      return;
    }

    ingestDrainTimer = setTimeout(() => {
      ingestDrainTimer = null;
      stallMonitor.section("drain_ingest_queue", drainIngestQueue);
    }, normalizedDelayMs);
  };

  const schedulers = {
    wakeIngest: scheduleIngestDrain,
    wakeProjection: (delayMs?: number) => scheduleProjectionDrain(delayMs),
    wakeSearchIndex: (delayMs?: number) => scheduleSearchIndexDrain(delayMs),
  };
  const queueDebouncedNativeSync = createDebouncedSyncEnqueuer(db, schedulers.wakeIngest);
  const {
    discordRealtime,
    slackRealtime,
    linkedInRealtime,
    signalRealtime,
    whatsAppRealtime,
    requestDiscordRealtimeReconcile,
    requestSlackRealtimeReconcile,
    requestLinkedInRealtimeReconcile,
    requestSignalRealtimeReconcile,
    requestWhatsAppRealtimeReconcile,
    runSignalSyncExclusively,
  } = createRealtimeSupervisors({
    db,
    schedulers,
    autoSyncPacing,
    shouldRunRealtimePlatform,
    signalReconnectSyncCooldownMs,
    // The ingest handlers are created further down, once projection and search indexing exist.
    // Supervisors only call them for session events, which start after the daemon is listening.
    handleSlackRealtimeEvent: (accountKey, event) => handleSlackRealtimeEvent(accountKey, event),
    handleDiscordRealtimeEvent: (accountKey, event) =>
      handleDiscordRealtimeEvent(accountKey, event),
    ingestLinkedInRealtimeEnvelope: (accountKey, envelope, userEntityUrn) =>
      ingestLinkedInRealtimeEnvelope(accountKey, envelope, userEntityUrn),
    ingestSignalRealtimeMessages: (accountKey, messages) =>
      ingestSignalRealtimeMessages(accountKey, messages),
    handleWhatsAppRealtimeEvent: (accountKey, event) =>
      handleWhatsAppRealtimeEvent(accountKey, event),
  });
  const { nativeWatchers, reconcileLocalWatchers, stopLocalWatchers } = createLocalWatchers({
    db,
    queueDebouncedNativeSync,
  });

  // The host discards the daemon's output, so without these a failure nothing awaited would
  // end the process with no trace. A rejected promise is logged and the daemon carries on;
  // after an exception its state cannot be trusted, so it exits and the host restarts it.
  process.on("unhandledRejection", (reason) => {
    daemonLogger.error("unhandled promise rejection", reason);
  });
  process.on("uncaughtException", (error) => {
    daemonLogger.error("uncaught exception; exiting", error);
    process.exit(1);
  });

  db.recoverInProgressRuns();
  const daemonIdentity = getDaemonIdentity();
  daemonLogger.info("daemon starting", {
    pid: process.pid,
    version: DAEMON_VERSION,
    executablePath: daemonIdentity.executablePath,
    appPath: daemonIdentity.appPath,
  });

  db.upsertDaemonState({
    pid: process.pid,
    startedAt,
    updatedAt: startedAt,
    status: "running",
    version: DAEMON_VERSION,
    details: daemonIdentity,
  });
  if (db.getPendingRollbackState()?.targetVersion === DAEMON_VERSION) {
    db.setUpdatePendingRollback(null);
    db.setUpdateLastError(null);
  }

  // The lock file is how the app and a second daemon tell this one is alive (stale after
  // SINGLETON_LOCK_STALE_MS), so it keeps its own short interval. It never touches SQLite. The
  // daemon_state row is refreshed by the status heartbeat further down.
  const heartbeat = setInterval(() => {
    daemonLease.heartbeat();
  }, SINGLETON_LOCK_HEARTBEAT_MS);

  const realtimeStatuses = () =>
    collectRealtimeSessionStatuses({
      discordRealtime,
      slackRealtime,
      linkedInRealtime,
      signalRealtime,
      whatsAppRealtime,
    });

  // Subscribed connections are told when UI-visible state changed, so the app re-reads on
  // change instead of polling. Topics raised in the same tick go out as one event.
  const subscribers = new Set<Socket>();
  const pendingEventTopics = new Set<DaemonEventTopic>();
  const notifySubscribers = (topic: DaemonEventTopic) => {
    if (subscribers.size === 0) {
      return;
    }
    const flushScheduled = pendingEventTopics.size > 0;
    pendingEventTopics.add(topic);
    if (flushScheduled) {
      return;
    }
    setImmediate(() => {
      const event: DaemonEvent = { event: "changed", topics: [...pendingEventTopics] };
      pendingEventTopics.clear();
      const line = `${JSON.stringify(event)}\n`;
      for (const subscriber of subscribers) {
        if (!subscriber.destroyed && subscriber.writable) {
          subscriber.write(line);
        }
      }
    });
  };
  const subscribe = (socket: Socket) => {
    subscribers.add(socket);
    socket.once("close", () => subscribers.delete(socket));
  };

  const dbWorker: DbWorker = new ResilientDbWorker(
    new ThreadDbWorker(db.dbPath),
    new InlineDbWorker(db),
    (error) =>
      daemonLogger.warn(
        "database worker unavailable; its jobs now run on the daemon thread",
        error,
      ),
  );
  // Checkpoint the WAL from the worker thread instead of inside the daemon's own commits. An
  // inline checkpoint is tens of milliseconds of copying and fsync in whichever commit happens
  // to cross the threshold, and that commit is on the thread every request waits on.
  db.setWalAutoCheckpointPages(WAL_BACKSTOP_AUTOCHECKPOINT_PAGES);
  let checkpointedAtChanges = db.totalChanges();
  let checkpointedAt = now();
  let checkpointInFlight = false;
  const maybeCheckpointWal = (totalChanges: number) => {
    if (checkpointInFlight) {
      return;
    }
    const changedRows = totalChanges - checkpointedAtChanges;
    const overdue = changedRows > 0 && now() - checkpointedAt >= WAL_CHECKPOINT_MAX_INTERVAL_MS;
    if (changedRows < WAL_CHECKPOINT_MIN_CHANGED_ROWS && !overdue) {
      return;
    }
    checkpointInFlight = true;
    checkpointedAtChanges += changedRows;
    checkpointedAt = now();
    dbWorker
      .run("checkpointWal")
      .catch((error) => {
        if (!shutdownInitiated) {
          daemonLogger.warn("background WAL checkpoint failed", error);
        }
      })
      .finally(() => {
        checkpointInFlight = false;
      });
  };
  // Counting rows costs no I/O, but a look every second is a wakeup every second all day.
  // While nothing is written the interval doubles up to WAL_CHECKPOINT_IDLE_POLL_MAX_MS; the
  // first look that sees a write returns to WAL_CHECKPOINT_POLL_MS. An overdue checkpoint
  // (a few rows, then quiet) is still taken within the idle interval of falling due.
  let walPollChanges = db.totalChanges();
  let walPollDelayMs = WAL_CHECKPOINT_POLL_MS;
  let walCheckpointTimer: NodeJS.Timeout | null = null;
  const pollWalCheckpoint = () => {
    const totalChanges = db.totalChanges();
    walPollDelayMs =
      totalChanges !== walPollChanges
        ? WAL_CHECKPOINT_POLL_MS
        : Math.min(walPollDelayMs * 2, WAL_CHECKPOINT_IDLE_POLL_MAX_MS);
    walPollChanges = totalChanges;
    maybeCheckpointWal(totalChanges);
    walCheckpointTimer = setTimeout(pollWalCheckpoint, walPollDelayMs);
    walCheckpointTimer.unref?.();
  };
  walCheckpointTimer = setTimeout(pollWalCheckpoint, walPollDelayMs);
  walCheckpointTimer.unref?.();
  // A sync is about to write in bulk on this thread. Left on its idle interval, the poll could
  // look as much as 30 s later, by which time the log may have grown to the size where SQLite
  // checkpoints it on this thread instead.
  const noteBulkWritesStarting = () => {
    if (walPollDelayMs <= WAL_CHECKPOINT_POLL_MS || shutdownInitiated) {
      return;
    }
    walPollDelayMs = WAL_CHECKPOINT_POLL_MS;
    if (walCheckpointTimer) {
      clearTimeout(walCheckpointTimer);
    }
    walCheckpointTimer = setTimeout(pollWalCheckpoint, walPollDelayMs);
    walCheckpointTimer.unref?.();
  };

  const readModel = new DaemonReadModel(db, dbWorker, {
    onChange: (topic) => {
      if (topic === "aggregates") {
        writeMenuBarStatus("aggregates");
      } else {
        notifySubscribers(topic);
      }
    },
    onError: (topic, error) => daemonLogger.warn("read model refresh failed", { topic, error }),
  });

  let menuBarStatusWriteTimer: NodeJS.Timeout | null = null;
  let lastMenuBarStatusWrittenAt = 0;
  const writeMenuBarStatus = (reason = "interval") => {
    if (menuBarStatusWriteTimer) {
      clearTimeout(menuBarStatusWriteTimer);
      menuBarStatusWriteTimer = null;
    }
    // Row counts come from the database worker. This recount is a no-op unless something
    // countable was written, and it calls back into this function when the counts move.
    void readModel.refreshAggregates();
    const aggregates = readModel.aggregates;
    if (!aggregates) {
      // First count is still running; keep the previous file until real numbers land.
      return;
    }
    try {
      const written = stallMonitor.section("menu_bar_status_write", () =>
        withoutWaitingForWriteLock(db, () => {
          writeMenuBarStatusSnapshot(db, { realtime: realtimeStatuses(), bootstrap, aggregates });
        }),
      );
      if (written === SQLITE_BUSY_SKIPPED) {
        daemonLogger.warn("menu bar status cache write deferred because SQLite is busy", {
          reason,
        });
        requestMenuBarStatusWrite(reason);
        return;
      }
      lastMenuBarStatusWrittenAt = now();
      notifySubscribers("status");
    } catch (error) {
      daemonLogger.warn("menu bar status cache write failed", { reason, error });
    }
  };
  const refreshMenuBarStatusNow = (reason: string) => {
    writeMenuBarStatus(reason);
  };
  const requestMenuBarStatusWrite = (reason: string) => {
    if (menuBarStatusWriteTimer) {
      return;
    }
    const elapsedMs = Math.max(0, now() - lastMenuBarStatusWrittenAt);
    const delayMs = Math.max(
      MENU_BAR_STATUS_EVENT_DEBOUNCE_MS,
      MENU_BAR_STATUS_EVENT_MIN_INTERVAL_MS - elapsedMs,
    );
    menuBarStatusWriteTimer = setTimeout(() => {
      menuBarStatusWriteTimer = null;
      writeMenuBarStatus(reason);
    }, delayMs);
  };
  writeMenuBarStatus();

  // Refreshes the daemon_state row and rewrites the status file. Every change the daemon knows
  // of already rewrites the file (requestMenuBarStatusWrite); this is the backstop that keeps
  // the row's updated_at live for the app and catches changes made by other processes.
  const statusHeartbeat = new BusyRetryingTimerJob({
    intervalMs: DAEMON_STATUS_HEARTBEAT_MS,
    busyRetryMs: TIMER_JOB_BUSY_RETRY_MS,
    run: () => {
      const written = stallMonitor.section("heartbeat", () =>
        withoutWaitingForWriteLock(db, () => {
          db.upsertDaemonState({
            pid: process.pid,
            startedAt,
            updatedAt: now(),
            status: "running",
            version: DAEMON_VERSION,
            details: daemonIdentity,
          });
        }),
      );
      if (written !== SQLITE_BUSY_SKIPPED) {
        writeMenuBarStatus("heartbeat");
      }
      return written;
    },
    onBusy: () => daemonLogger.warn("heartbeat deferred because SQLite is busy"),
    onRecovered: (retries) =>
      daemonLogger.info("heartbeat written after SQLite was busy", { retries }),
  });
  statusHeartbeat.start();

  const hasConnectedRealtime = (platform: Platform, accountKey: string): boolean =>
    [
      ...discordRealtime.getStatuses(),
      ...linkedInRealtime.getStatuses(),
      ...signalRealtime.getStatuses(),
      ...whatsAppRealtime.getStatuses(),
    ].some(
      (status) =>
        status.platform === platform &&
        status.accountKey === accountKey &&
        status.state === "connected",
    );

  const hasConnectedSlackRealtime = (accountKey: string): boolean =>
    slackRealtime
      .getStatuses()
      .some((status) => status.accountKey === accountKey && status.state === "connected");
  const autoSyncPushPathFor = (platform: AdapterPlatform, accountKey: string) =>
    autoSyncPushPath(platform, {
      watcherRunning: (watcher) => isNativeWatcherRunning(nativeWatchers.get(watcher)),
      realtimeConnected:
        platform === "slack"
          ? hasConnectedSlackRealtime(accountKey)
          : hasConnectedRealtime(platform, accountKey),
    });
  const schedulerWakeDetector = new SchedulerWakeDetector(getAutoSyncSchedulerTickMs());

  const autoSyncBusyRetries = new Map<string, NodeJS.Timeout>();
  const queueAutoSyncRuns = (trigger: string) => {
    if (isUpdateShutdownRequested) {
      return;
    }
    const pendingRetry = autoSyncBusyRetries.get(trigger);
    if (pendingRetry) {
      clearTimeout(pendingRetry);
      autoSyncBusyRetries.delete(trigger);
    }
    // Outside the transaction: a run queued for one account still needs the ingest queue
    // woken if the lock turns out to be busy when the next account is queued.
    let queuedAny = false;
    try {
      db.withBusyTimeoutSync(TIMER_JOB_BUSY_TIMEOUT_MS, () => {
        if (trigger === "scheduler" && bootstrap.state !== "ready") {
          return;
        }
        if (trigger === "scheduler" && autoSyncProjectionBacklogPauseEvents > 0) {
          const projection = db.getProjectionBacklog();
          if (projection.pending_raw_events >= autoSyncProjectionBacklogPauseEvents) {
            daemonLogger.info("autosync queue deferred while projection backlog drains", {
              pendingRawEvents: projection.pending_raw_events,
              threshold: autoSyncProjectionBacklogPauseEvents,
            });
            return;
          }
        }
        const autoSyncTargets = getAutoSyncTargets(db);
        const queuedAt = now();
        // One read of the host's file per tick: power for the caps, wake time for the reset.
        const host = trigger === "scheduler" ? readHostState() : null;
        if (host && schedulerWakeDetector.check(queuedAt, host.sleep?.lastWakeAt)) {
          autoSyncPacing.resetAll();
        }
        for (const target of autoSyncTargets) {
          if (trigger === "scheduler") {
            const targetKey = `${target.platform}:${target.accountKey}`;
            const lastQueuedAt = lastAutoSyncQueuedAt.get(targetKey) ?? startedAt;
            const configuredInterval =
              process.env.CUED_AUTOSYNC_INTERVAL_MS != null ||
              process.env[`CUED_AUTOSYNC_INTERVAL_${target.platform.toUpperCase()}_MS`] != null;
            const intervalMs = configuredInterval
              ? getAutoSyncIntervalMs(target.platform)
              : autoSyncPacing.interval(targetKey, {
                  baseMs: getAutoSyncIntervalMs(target.platform),
                  push: autoSyncPushPathFor(target.platform, target.accountKey),
                  power: host?.power ?? null,
                });
            if (!isScheduledSyncDue({ nowMs: queuedAt, lastQueuedAt, intervalMs })) {
              continue;
            }
          }

          if (
            shouldSkipConnectedDiscordSchedulerSync(
              target.platform,
              trigger,
              target.platform === "discord"
                ? (discordRealtime.getSession(target.accountKey)?.getStatus() ?? null)
                : null,
            )
          ) {
            continue;
          }

          if (db.hasQueuedOrRunningRun(target.platform, target.accountKey)) {
            continue;
          }

          db.queueSyncRun({
            platform: target.platform,
            accountKey: target.accountKey,
            runType: "sync",
            trigger,
            details: { source: target.platform, accountKey: target.accountKey, trigger },
          });
          lastAutoSyncQueuedAt.set(`${target.platform}:${target.accountKey}`, queuedAt);
          queuedAny = true;
        }
      });
    } catch (error) {
      if (!isSqliteBusyError(error)) {
        throw error;
      }
      daemonLogger.warn("autosync queue deferred because SQLite is busy", { trigger });
      autoSyncBusyRetries.set(
        trigger,
        setTimeout(() => {
          autoSyncBusyRetries.delete(trigger);
          stallMonitor.section("auto_sync_scheduler", () => queueAutoSyncRuns(trigger));
        }, TIMER_JOB_BUSY_RETRY_MS),
      );
    } finally {
      if (queuedAny) {
        schedulers.wakeIngest();
      }
    }
  };

  const stopRealtimeAndWatchers = () => {
    stopLocalWatchers();
    discordRealtime.stopAll();
    slackRealtime.stopAll();
    nativeWatchers.clear();
    linkedInRealtime.stopAll();
    signalRealtime.stopAll();
    whatsAppRealtime.stopAll();
  };

  const maybeFinishUpdateShutdown = () => {
    if (!isUpdateShutdownRequested || shutdownInitiated) {
      return;
    }
    const deadlineReached =
      updateShutdownRequestedAt != null &&
      now() - updateShutdownRequestedAt >= UPDATE_SHUTDOWN_GRACE_MS;
    if (deadlineReached || (activeIngestRuns.size === 0 && !isProcessingProjection())) {
      shutdown();
    }
  };

  const requestUpdateShutdown = () => {
    if (isUpdateShutdownRequested) {
      return {
        shuttingDown: true,
        requestedAt: updateShutdownRequestedAt,
      };
    }

    isUpdateShutdownRequested = true;
    updateShutdownRequestedAt = now();
    daemonLogger.info("daemon entering update shutdown", {
      activeIngestRuns: activeIngestRuns.size,
      isProcessingProjection: isProcessingProjection(),
    });
    stopRealtimeAndWatchers();
    setImmediate(maybeFinishUpdateShutdown);

    return {
      shuttingDown: true,
      requestedAt: updateShutdownRequestedAt,
    };
  };

  const scheduleUpdateCheck = (force = false) => {
    if (updateCheckPromise || isUpdateShutdownRequested) {
      return;
    }

    updateCheckPromise = (async () => {
      try {
        await checkForUpdates(db, { force });
      } catch (error) {
        daemonLogger.warn("background update check failed", error);
      } finally {
        updateCheckPromise = null;
      }
    })();
  };
  const completeBootstrap = (state: DaemonBootstrapSnapshot["state"], error?: unknown) => {
    bootstrap.state = state;
    bootstrap.finishedAt = now();
    bootstrap.error = error ? (error instanceof Error ? error.message : String(error)) : null;
  };
  const runBootstrap = async () => {
    try {
      try {
        // A sign-in left unfinished by the previous daemon can never report back.
        reconcileAbandonedAuthSessions(db, { ownerGone: true });
      } catch (error) {
        daemonLogger.warn("could not cancel sign-ins left by the previous daemon", error);
      }
      // Status and capability checks read each helper's version synchronously. Look them up
      // here, without blocking, so those reads never have to spawn anything.
      await Promise.all([warmSlackHelperInspection(), warmWhatsAppHelperInspection()]);
      const { localIntegrationStates } = await readModel.refreshLocalAccess({ maxAgeMs: 0 });
      try {
        await refreshManagedIntegrationStates(db, { localIntegrationStates });
      } catch (error) {
        // One integration that cannot be refreshed (a helper missing, a desktop session that
        // cannot be read) must not keep sync and realtime from starting for all the others.
        daemonLogger.warn("managed integration refresh failed during bootstrap", error);
      }
      if (shouldBootstrapLocalIntegrations(db.getAppMetadata())) {
        reconcileLocalWatchers();
      }
      queueAutoSyncRuns("daemon_start");
      requestDiscordRealtimeReconcile();
      requestSlackRealtimeReconcile();
      requestLinkedInRealtimeReconcile();
      requestSignalRealtimeReconcile();
      requestWhatsAppRealtimeReconcile();
      if (db.getProjectionBacklog().pending_raw_events > 0) {
        queueProjectionRun("daemon_bootstrap_backlog", undefined, { delayMs: 0 });
      }
      scheduleUpdateCheck(false);
      completeBootstrap("ready");
      // Build one snapshot now, so the first one a client asks for is not the one that pays
      // for cold code paths and first-time file reads.
      void buildOnboardingSnapshot(db, {
        installGlobalSkill: false,
        globalSkillMonitor: readModel.skill,
        localAccess: readModel.localAccess ?? undefined,
        aggregates: readModel.aggregates ?? undefined,
      }).catch(() => undefined);
    } catch (error) {
      daemonLogger.warn("daemon bootstrap failed", error);
      completeBootstrap("failed", error);
    }
  };

  async function processIngestRun(
    currentRun: NonNullable<ReturnType<typeof db.claimNextQueuedRun>>,
  ) {
    noteBulkWritesStarting();
    const sleepDetector = new SleepInterruptionDetector();
    const sleepWatch = setInterval(() => sleepDetector.check(), 1_000);
    const ingestStartedAt = now();
    const runClaim = { ownerId: currentRun.owner_id, attempt: currentRun.attempt };
    const assertRunStillOwned = () => {
      if (!db.updateRunProgress(currentRun.id, { leaseMs: INGEST_RUN_LEASE_MS, claim: runClaim })) {
        throw new IngestRunSupersededError(currentRun.id);
      }
    };
    const ingestInsertHooks = {
      assertStillWanted: assertRunStillOwned,
      // Register message hooks as each slice lands. Inserting yields between slices, and a
      // projection run that starts meanwhile must find the hooks for the rows it covers.
      onInserted: (inserted: RawEventInsertResult) => {
        if (inserted.firstInsertedRowId == null || inserted.lastInsertedRowId == null) {
          return;
        }
        queueMessageReceivedHooks(
          { startRowId: inserted.firstInsertedRowId, endRowId: inserted.lastInsertedRowId },
          collectInboundMessageHookPayloads(
            currentRun.id,
            inserted.insertedRows,
            isInboundMessageEvent,
          ),
        );
      },
    };
    daemonLogger.info("ingest run started", {
      runId: currentRun.id,
      platform: currentRun.platform,
      accountKey: currentRun.account_key,
      trigger: currentRun.trigger,
      runType: currentRun.run_type,
    });
    telemetry.enqueue("sync_started", {
      component: "sync",
      operation: "ingest",
      stage: "ingest",
      run_id: currentRun.id,
      platform: currentRun.platform ?? "all",
      run_type: currentRun.run_type,
      trigger: currentRun.trigger,
    });
    try {
      if (
        (currentRun.run_type !== "sync" && currentRun.run_type !== "sync_resume") ||
        !currentRun.platform
      ) {
        db.failRun(
          currentRun.id,
          `Unsupported ingest run target: ${currentRun.run_type}:${currentRun.platform ?? "none"}`,
          undefined,
          null,
          runClaim,
        );
        return;
      }
      if (!isAdapterPlatform(currentRun.platform)) {
        db.failRun(
          currentRun.id,
          `No adapter registered for platform: ${currentRun.platform}`,
          undefined,
          null,
          runClaim,
        );
        telemetry.enqueue("sync_failed", {
          component: "sync",
          operation: "ingest",
          stage: "validation",
          run_id: currentRun.id,
          platform: currentRun.platform,
          run_type: currentRun.run_type,
          trigger: currentRun.trigger,
          ...errorTelemetryProperties("No adapter registered", "adapter_missing"),
        });
        return;
      }

      const platform = currentRun.platform;
      const accountKey = currentRun.account_key ?? getDefaultAccountKeyForPlatform(platform);
      const runDetails = safeParseJsonRecord(
        currentRun.details_json ?? null,
        "sync_runs.details_json",
      );
      const checkpoint = db.getCheckpoint(currentRun.platform, accountKey);
      const sourceCursor = safeParseJsonRecord(
        checkpoint?.source_cursor_json ?? null,
        "sync_checkpoints.source_cursor_json",
      );
      const envOverrides = {
        ...buildAdapterInvocationEnv({
          platform,
          checkpointSourceCursorJson: checkpoint?.source_cursor_json ?? null,
          proofs: selectAdapterInvocationProofs({
            platform,
            proofs: db.listSyncProofs(platform, accountKey),
            sourceCursor,
          }),
        }),
        ...(platform === "whatsapp" && runDetails?.source === "whatsapp_desktop"
          ? { CUED_WHATSAPP_SYNC_SOURCE: "desktop_db" }
          : {}),
      };

      const adapterStartedAt = now();
      let adapterFetchMs = 0;
      let rawEventInsertMs = 0;
      let ingestedCount = 0;
      let bundleHasMore = false;
      let bundleSyncMode: "full" | "incremental" = checkpoint?.source_cursor_json
        ? "incremental"
        : "full";
      let bundleSourceCursor: Record<string, unknown> | null = null;
      let bundleContinuation: SyncContinuation | null = null;
      let runDiagnostics: Record<string, unknown> | null = null;
      let checkpointLastSuccessAt = now();
      let sourceAccounts: Array<{
        platform: Platform;
        accountKey: string;
        displayName?: string | null;
      }> = [];
      let insertResult = EMPTY_RAW_EVENT_INSERT_RESULT;
      telemetry.enqueue("helper_started", {
        component: "sync",
        operation: "adapter",
        stage: "adapter",
        run_id: currentRun.id,
        platform,
        run_type: currentRun.run_type,
        helper_kind: platform,
      });

      if (platform === "whatsapp" && runDetails?.source !== "whatsapp_desktop") {
        const session = await whatsAppRealtime.waitForConnected(accountKey, 10_000);
        if (!session?.isConnected()) {
          throw new Error(`WhatsApp session is not connected for '${accountKey}'`);
        }

        sourceAccounts = [
          {
            platform: "whatsapp",
            accountKey,
            displayName: "WhatsApp",
          },
        ];
        const whatsappCursor = parseWhatsAppSourceCursor(sourceCursor);
        let cursor: string | null = whatsappCursor.resyncCursor ?? null;
        bundleSyncMode = cursor
          ? (whatsappCursor.resyncSyncMode ??
            (checkpoint?.sync_mode as "full" | "incremental") ??
            "full")
          : checkpoint?.source_cursor_json
            ? "incremental"
            : "full";
        const sinceMs = selectWhatsAppHelperSinceMs({
          cursor,
          sourceCursor: whatsappCursor,
          syncMode: bundleSyncMode,
          checkpointLastSuccessAt: checkpoint?.last_success_at ?? null,
        });
        const resyncStartedAt = whatsappCursor.resyncStartedAt ?? ingestStartedAt;
        const pageBudget = getWhatsAppResyncPageBudget();
        let pageCount = 0;
        let resyncStats = whatsappCursor.resyncStats ?? emptyWhatsAppResyncStats();
        let resyncCoverage = whatsappCursor.resyncCoverage ?? {
          oldestMessageAt: null,
          newestMessageAt: null,
        };
        let historyBackfillRequestedAt = whatsappCursor.historyBackfillRequestedAt;
        if (!cursor && historyBackfillRequestedAt == null) {
          const anchors = db.listWhatsAppHistoryBackfillAnchors(accountKey, 25);
          if (anchors.length > 0) {
            const backfill = await requestWhatsAppHistoryBackfillOnce({
              anchors,
              request: (request) => session.requestHistoryBackfill(request),
            });
            historyBackfillRequestedAt = backfill.historyBackfillRequestedAt ?? undefined;
            runDiagnostics = {
              ...(runDiagnostics ?? {}),
              historyBackfill: backfill.diagnostics,
            };
            if (backfill.historyBackfillRequestedAt == null) {
              whatsAppLogger.warn("history backfill request failed", {
                accountKey,
                error:
                  typeof backfill.diagnostics.error === "string"
                    ? backfill.diagnostics.error
                    : "unknown",
              });
            }
          }
        }
        let hasMore = false;
        let lastCompletedAt = now();
        do {
          // Checked on both sides of the fetch: before, so a reset or reclaimed run stops asking
          // for pages; after, because the helper can take a while and everything below (rows,
          // proof, cursor) would otherwise be written back over what the reset just deleted.
          // Each check also renews the lease.
          assertRunStillOwned();
          const pageFetchStartedAt = now();
          const page = await session.resync({
            cursor,
            sinceMs,
            limit: 1000,
          });
          assertRunStillOwned();
          adapterFetchMs += now() - pageFetchStartedAt;
          pageCount += 1;
          const pageCoverage = summarizeWhatsAppMessageCoverage(page.messages ?? []);

          const rawEvents = withRawEventAcquisitionMode(
            buildWhatsAppRawEventsFromSnapshot({
              accountKey,
              snapshot: page,
            }),
            "sync",
          );
          ingestedCount += rawEvents.length;
          resyncStats = addWhatsAppResyncStats(resyncStats, {
            pageCount: 1,
            contactCount: page.contacts?.length ?? 0,
            chatCount: page.chats?.length ?? 0,
            messageCount: page.messages?.length ?? 0,
            rawEventCount: rawEvents.length,
          });
          resyncCoverage = mergeWhatsAppResyncCoverage(resyncCoverage, pageCoverage);
          lastCompletedAt = page.completedAt ?? now();
          hasMore = page.hasMore;
          cursor = page.nextCursor ?? null;

          const pageInsertStartedAt = now();
          const pageInsertResult = await insertRawEventsYielding(db, rawEvents, ingestInsertHooks);
          rawEventInsertMs += now() - pageInsertStartedAt;
          assertRunStillOwned();
          insertResult = mergeRawEventInsertResults(insertResult, pageInsertResult);
        } while (hasMore && pageCount < pageBudget);

        bundleHasMore = hasMore;
        bundleContinuation = hasMore
          ? {
              reason: "account_pagination",
              detail: "WhatsApp helper resync page remains",
              scope: {
                kind: "account",
                key: "messages",
                proofKind: "messages",
              },
            }
          : null;
        bundleSourceCursor = {
          ...(whatsappCursor.desktopDb ? { desktopDb: whatsappCursor.desktopDb } : {}),
          ...(historyBackfillRequestedAt != null ? { historyBackfillRequestedAt } : {}),
          lastSyncAt: hasMore
            ? (whatsappCursor.lastSyncAt ?? checkpoint?.last_success_at)
            : lastCompletedAt,
          ...(hasMore
            ? {
                resyncCursor: cursor,
                resyncSinceMs: sinceMs,
                resyncStartedAt,
                resyncSyncMode: bundleSyncMode,
                resyncStats,
                resyncCoverage,
              }
            : {}),
        };
        checkpointLastSuccessAt = hasMore
          ? (checkpoint?.last_success_at ?? lastCompletedAt)
          : lastCompletedAt;
        db.upsertSyncProof({
          platform,
          accountKey,
          proof: buildWhatsAppMessagesProof({
            accountKey,
            syncMode: bundleSyncMode,
            observedAt: now(),
            runStartedAt: resyncStartedAt,
            hasMore,
            nextCursor: cursor,
            sinceMs,
            completedAt: lastCompletedAt,
            stats: resyncStats,
            coverage: resyncCoverage,
          }),
        });
      } else {
        db.updateRunProgress(currentRun.id, { leaseMs: INGEST_RUN_LEASE_MS, claim: runClaim });
        const bundle =
          platform === "signal"
            ? await runSignalSyncExclusively(
                accountKey,
                async () => await runAdapter(platform, accountKey, envOverrides),
              )
            : await runAdapter(platform, accountKey, envOverrides);
        adapterFetchMs = now() - adapterStartedAt;
        // The fetch can take a long time. If the source was reset or the run reclaimed while it
        // ran, recording this bundle and its cursor would skip whatever was deleted.
        assertRunStillOwned();
        sourceAccounts = bundle.sourceAccounts as typeof sourceAccounts;
        bundleSourceCursor =
          (bundle.sourceCursor as Record<string, unknown> | undefined | null) ?? null;
        bundleSyncMode = bundle.syncMode ?? bundleSyncMode;
        bundleHasMore = bundle.hasMore ?? false;
        bundleContinuation = bundle.continuation ?? null;
        const bundleDiagnostics =
          bundle.diagnostics && Object.keys(bundle.diagnostics).length > 0
            ? bundle.diagnostics
            : null;
        ingestedCount = bundle.rawEvents.length;
        const rawEventInsertStartedAt = now();
        insertResult = await insertRawEventsYielding(
          db,
          withRawEventAcquisitionMode(bundle.rawEvents, "sync"),
          ingestInsertHooks,
        );
        rawEventInsertMs = now() - rawEventInsertStartedAt;
        const bundleProofs = Array.isArray(bundle.proofs) ? bundle.proofs : [];
        for (const proof of bundleProofs) {
          db.upsertSyncProof({
            platform,
            accountKey,
            proof,
          });
        }
        if (platform === "discord") {
          const discordHydration =
            bundleDiagnostics &&
            typeof bundleDiagnostics.discordHydration === "object" &&
            bundleDiagnostics.discordHydration !== null
              ? (bundleDiagnostics.discordHydration as Record<string, unknown>)
              : null;
          if (discordHydration?.partial === true) {
            daemonLogger.warn("discord sync hydration partial", {
              runId: currentRun.id,
              platform,
              accountKey,
              diagnostics: discordHydration,
            });
          }
        }
        checkpointLastSuccessAt = now();
        runDiagnostics = bundleDiagnostics;
      }

      db.upsertSourceAccounts(sourceAccounts);
      const realtimeProjectionStartedAt = now();
      if (
        shouldProjectIngestRunInline({
          platform,
          runType: currentRun.run_type,
          realtimeProjectionEnabled,
          firstInsertedRowId: insertResult.firstInsertedRowId,
          lastInsertedRowId: insertResult.lastInsertedRowId,
          insertedRawEvents: insertResult.insertedCount,
        })
      ) {
        projectRealtimeRange(db, {
          startRowId: insertResult.firstInsertedRowId!,
          endRowId: insertResult.lastInsertedRowId!,
          batchSize: realtimeProjectionBatchSize,
          includeOverview: false,
        });
        scheduleSearchIndexDrain();
      }
      const afterRealtimeProjection = now();
      const projection = db.getProjectionBacklog();
      const checkpointSyncMode = resolveCheckpointSyncMode(
        currentRun.run_type,
        checkpoint?.sync_mode,
        bundleSyncMode,
        bundleHasMore,
      );
      const checkpointStartedAt = now();
      db.upsertCheckpoint({
        platform: currentRun.platform,
        accountKey,
        syncMode: checkpointSyncMode,
        sourceCursor: bundleSourceCursor,
        rawIngestWatermark: projection.max_raw_event_rowid,
        lastSuccessAt: checkpointLastSuccessAt,
      });
      const afterCheckpoint = now();
      const timings: IngestTiming = {
        adapterFetchMs,
        rawEventInsertMs,
        realtimeProjectionMs: afterRealtimeProjection - realtimeProjectionStartedAt,
        checkpointUpdateMs: afterCheckpoint - checkpointStartedAt,
        webhookReadyMs: afterCheckpoint - ingestStartedAt,
        totalMs: afterCheckpoint - ingestStartedAt,
        insertedRawEvents: insertResult.insertedCount,
      };

      let projectionQueued = false;
      if (projection.pending_raw_events > 0) {
        const continuationProjectionKey = `${currentRun.platform}:${accountKey}`;
        const lastContinuationProjectionAt =
          lastContinuationProjectionQueuedAt.get(continuationProjectionKey) ?? 0;
        const projectionDecisionAt = now();
        const shouldDeferProjection = shouldDeferContinuationProjection({
          hasMore: bundleHasMore,
          pendingRawEvents: projection.pending_raw_events,
          lastProjectionQueuedAt: lastContinuationProjectionAt,
          nowMs: projectionDecisionAt,
          intervalMs: continuationProjectionIntervalMs,
          backlogEvents: continuationProjectionBacklogEvents,
        });

        if (shouldDeferProjection) {
          daemonLogger.info("projection deferred during continuation sync", {
            runId: currentRun.id,
            platform: currentRun.platform,
            accountKey,
            pendingRawEvents: projection.pending_raw_events,
            continuationProjectionIntervalMs,
            continuationProjectionBacklogEvents,
          });
        } else {
          queueProjectionRun(`ingest:${currentRun.platform}:${accountKey}`, undefined, {
            delayMs: deferredProjectionCoalesceMs,
          });
          if (bundleHasMore) {
            lastContinuationProjectionQueuedAt.set(continuationProjectionKey, projectionDecisionAt);
          } else {
            lastContinuationProjectionQueuedAt.delete(continuationProjectionKey);
          }
          projectionQueued = true;
        }
      } else if (
        insertResult.firstInsertedRowId != null &&
        insertResult.lastInsertedRowId != null
      ) {
        await releaseMessageReceivedHooksForRange({
          startRowId: insertResult.firstInsertedRowId,
          endRowId: insertResult.lastInsertedRowId,
        });
      }
      db.finishRun(
        currentRun.id,
        {
          ingested: ingestedCount,
          insertedRawEvents: insertResult.insertedCount,
          projectionQueued,
          hasMore: bundleHasMore,
          syncMode: checkpointSyncMode,
          timings,
          ...(bundleContinuation ? { continuation: bundleContinuation } : {}),
          ...(runDiagnostics ? { diagnostics: runDiagnostics } : {}),
        },
        runClaim,
      );
      if (platform === "signal") {
        requestSignalRealtimeReconcile();
      }
      const originTrigger =
        typeof runDetails?.originTrigger === "string"
          ? runDetails.originTrigger
          : currentRun.trigger;
      autoSyncPacing.record(`${platform}:${accountKey}`, {
        insertedEvents: insertResult.insertedCount,
        hasMore: bundleHasMore,
        trigger: originTrigger,
      });
      if (bundleHasMore && !db.hasQueuedOrRunningRun(currentRun.platform, accountKey)) {
        const baseContinuationDelayMs = getSyncContinueDelayMsForPlatform(currentRun.platform);
        const continuationDelayMs = historyContinuationDelayMs({
          baseMs: baseContinuationDelayMs,
          originTrigger,
          // What this run fetched. The checkpoint's mode is "full" whenever more remains,
          // which would also slow an incremental catch-up that ran past its page budget.
          syncMode: bundleSyncMode,
          liveCoverage: hasConnectedRealtime(platform, accountKey),
          continuationReason: bundleContinuation?.reason,
          power: readHostPowerState(),
        });
        db.queueSyncRun({
          platform: currentRun.platform,
          accountKey,
          runType: "sync_resume",
          trigger: "ingest_continue",
          delayMs: continuationDelayMs,
          details: {
            source: currentRun.platform,
            accountKey,
            trigger: "ingest_continue",
            originTrigger,
            powerDeferred: continuationDelayMs > baseContinuationDelayMs,
            ...(bundleContinuation ? { continuation: bundleContinuation } : {}),
          },
        });
        schedulers.wakeIngest(continuationDelayMs);
      }
      if (!bundleHasMore) {
        requestMenuBarStatusWrite("ingest_completed");
      }
      await safeEmitHookEvent("sync.completed", {
        runId: currentRun.id,
        platform,
        accountKey,
        runType: currentRun.run_type,
        stage: "ingest",
        ingested: ingestedCount,
        insertedRawEvents: insertResult.insertedCount,
        timings,
      });
      telemetry.enqueue("sync_completed", {
        component: "sync",
        operation: "ingest",
        stage: "ingest",
        run_id: currentRun.id,
        platform,
        run_type: currentRun.run_type,
        trigger: currentRun.trigger,
        duration_bucket: durationBucket(now() - ingestStartedAt),
      });
      daemonLogger.info("ingest run completed", {
        runId: currentRun.id,
        platform,
        accountKey,
        insertedRawEvents: insertResult.insertedCount,
        insertedRawEventSchemas: summarizeRawEventsBySchema(insertResult.insertedEvents),
        totalMs: timings.totalMs,
        ...(runDiagnostics ? { diagnostics: runDiagnostics } : {}),
      });
    } catch (error) {
      if (error instanceof IngestRunSupersededError) {
        daemonLogger.info("ingest run abandoned after losing its claim", {
          runId: currentRun.id,
          platform: currentRun.platform,
          accountKey: currentRun.account_key,
        });
        return;
      }
      if (error instanceof SyncInterruptedBySleep || sleepDetector.check()) {
        db.deferRun(currentRun.id, now() + 10_000, runClaim);
        daemonLogger.info("ingest run deferred after sleep", {
          runId: currentRun.id,
          platform: currentRun.platform,
        });
        schedulers.wakeIngest(10_000);
        requestMenuBarStatusWrite("ingest_deferred");
        return;
      }
      autoSyncPacing.reset(
        `${currentRun.platform}:${currentRun.account_key ?? getDefaultAccountKeyForPlatform(currentRun.platform as Platform)}`,
      );
      const errorMessage = error instanceof Error ? error.message : String(error);
      daemonLogger.error("ingest run failed", {
        runId: currentRun.id,
        platform: currentRun.platform,
        accountKey: currentRun.account_key,
        error: errorMessage,
      });
      if (currentRun.platform && isPlatform(currentRun.platform)) {
        db.recordCheckpointError(
          currentRun.platform,
          currentRun.account_key ?? getDefaultAccountKeyForPlatform(currentRun.platform),
          errorMessage,
        );
      }
      if (currentRun.platform === "discord" && isDiscordAuthInvalidationError(error)) {
        blockDiscordIntegration(
          db,
          currentRun.account_key ?? getDefaultAccountKeyForPlatform("discord"),
          errorMessage,
        );
        requestDiscordRealtimeReconcile();
      }
      if (isAdapterAuthInvalidation(currentRun.platform, error)) {
        invalidateIntegrationAuth(
          db,
          currentRun.platform,
          currentRun.account_key ?? getDefaultAccountKeyForPlatform(currentRun.platform),
          {
            errorSummary: errorMessage,
            reason: `${currentRun.platform}_auth_invalidated`,
          },
        );
        if (currentRun.platform === "linkedin") requestLinkedInRealtimeReconcile();
        if (currentRun.platform === "slack") requestSlackRealtimeReconcile();
        requestMenuBarStatusWrite(`${currentRun.platform}_auth_invalidated`);
      }
      db.failRun(currentRun.id, errorMessage, undefined, null, runClaim);
      if (currentRun.platform === "signal") {
        requestSignalRealtimeReconcile();
      }
      const failureProperties = {
        component: "sync",
        operation: "ingest",
        stage: "ingest",
        run_id: currentRun.id,
        platform: currentRun.platform ?? "unknown",
        run_type: currentRun.run_type,
        trigger: currentRun.trigger,
        duration_bucket: durationBucket(now() - ingestStartedAt),
        ...errorTelemetryProperties(error, "sync_failed"),
      };
      telemetry.enqueue("helper_failed", {
        ...failureProperties,
        operation: "adapter",
        helper_kind: currentRun.platform ?? "unknown",
      });
      telemetry.enqueue("sync_failed", failureProperties);
      await safeEmitHookEvent("sync.failed", {
        runId: currentRun.id,
        platform: currentRun.platform,
        runType: currentRun.run_type,
        stage: "ingest",
        error: errorMessage,
      });
    } finally {
      clearInterval(sleepWatch);
    }
  }

  const {
    scheduleProjectionDrain,
    queueProjectionRun,
    isProcessingProjection,
    stopProjectionDrain,
  } = createProjectionRunner({
    db,
    telemetry,
    stallMonitor,
    bootstrap,
    runOwnerId,
    activeIngestRuns,
    projectionMessageHooks,
    deferredProjectionCoalesceMs,
    isUpdateShutdownRequested: () => isUpdateShutdownRequested,
    scheduleSearchIndexDrain: (delayMs?: number) => scheduleSearchIndexDrain(delayMs),
    requestMenuBarStatusWrite,
    maybeFinishUpdateShutdown,
  });

  const { scheduleSearchIndexDrain, stopSearchIndexDrain } = createSearchIndexDrain({
    db,
    dbWorker,
    stallMonitor,
    bootstrap,
    isUpdateShutdownRequested: () => isUpdateShutdownRequested,
    isShutdownInitiated: () => shutdownInitiated,
    isProcessingProjection,
    requestMenuBarStatusWrite,
  });

  const {
    handleSlackRealtimeEvent,
    handleDiscordRealtimeEvent,
    ingestLinkedInRealtimeEnvelope,
    ingestSignalRealtimeMessages,
    handleWhatsAppRealtimeEvent,
  } = createRealtimeIngest({
    db,
    schedulers,
    realtimeProjectionEnabled,
    realtimeProjectionBatchSize,
    deferredProjectionCoalesceMs,
    isProcessingProjection,
    scheduleSearchIndexDrain,
    queueProjectionRun,
    queueMessageReceivedHooks,
    releaseMessageReceivedHooksForRange,
  });

  const schedulerLoop = setInterval(() => {
    stallMonitor.section("auto_sync_scheduler", () => queueAutoSyncRuns("scheduler"));
  }, getAutoSyncSchedulerTickMs());

  const updateLoop = setInterval(() => {
    scheduleUpdateCheck(false);
  }, UPDATE_CHECK_INTERVAL_MS);

  // Old pre-update backups, rollback copies and downloads add up to many gigabytes. Removing them
  // uses asynchronous filesystem calls only, and a failure is retried on the next pass.
  const updateArtifactRetention = scheduleUpdateArtifactRetention({
    startDelayMs: UPDATE_ARTIFACT_RETENTION_START_DELAY_MS,
    intervalMs: UPDATE_ARTIFACT_RETENTION_INTERVAL_MS,
    run: async () => {
      try {
        const result = await pruneUpdateArtifacts({
          backupsDir: CUED_BACKUPS_DIR,
          rollbackDir: CUED_UPDATE_ROLLBACK_DIR,
          downloadsDir: CUED_UPDATE_DOWNLOADS_DIR,
          dbPath: CUED_DB_PATH,
          currentVersion: DAEMON_VERSION,
          pendingRollback: db.getPendingRollbackState(),
        });
        if (result.removed.length > 0 || result.failed.length > 0) {
          daemonLogger.info("removed old update copies", {
            removed: result.removed.length,
            removedFileBytes: result.removedBytes,
            failed: result.failed,
          });
        }
      } catch (error) {
        daemonLogger.warn("update copy retention failed", error);
      }
    },
  });

  // Profiles of the Chromium Cued used to bundle (hundreds of MB, read by nothing). Removed once,
  // with asynchronous filesystem calls, never while a sign-in is in progress.
  const legacyBrowserProfileCleanup = scheduleLegacyBrowserProfileCleanup({
    cuedHome: CUED_HOME,
    browserRoot: CUED_BROWSER_DIR,
    isSignInActive: () =>
      activeAuthSessions.size > 0 ||
      db.listAuthSessions(5).some((session) => session.state === "in_progress"),
    startDelayMs: UPDATE_ARTIFACT_RETENTION_START_DELAY_MS,
    retryMs: LEGACY_BROWSER_PROFILE_CLEANUP_RETRY_MS,
    log: (message, details) => daemonLogger.info(message, details),
  });

  let lastForegroundRequestAt = 0;
  const syncRunMaintenance = new SyncRunMaintenance(dbWorker, {
    // History cleanup can always wait. It never contends with a sync or projection for the
    // write lock, and it stays out of the way while someone is using the app or the CLI.
    shouldDefer: () =>
      isProcessingProjection() ||
      activeIngestRuns.size > 0 ||
      now() - lastForegroundRequestAt < FOREGROUND_QUIET_PERIOD_MS,
    onError: (error) => daemonLogger.warn("sync run maintenance failed", error),
    onPruned: ({ deletedRuns, durationMs }) =>
      daemonLogger.info("pruned sync run history", {
        deletedRuns,
        durationMs: Math.round(durationMs),
      }),
  });
  syncRunMaintenance.start();

  const requestAllRealtimeReconciles = () => {
    requestDiscordRealtimeReconcile();
    requestSlackRealtimeReconcile();
    requestLinkedInRealtimeReconcile();
    requestSignalRealtimeReconcile();
    requestWhatsAppRealtimeReconcile();
  };
  const recheckLocalAccessForManualSync = async (source: string | undefined) => {
    if (localSyncSourcesToRecheck(db, source).length === 0) {
      return;
    }
    try {
      const { localIntegrationStates } = await readModel.refreshLocalAccess({ maxAgeMs: 0 });
      refreshLocalIntegrationStates(db, localIntegrationStates);
      reconcileLocalWatchers();
    } catch (error) {
      daemonLogger.warn("local access check before a manual sync failed", error);
    }
  };
  let managedIntegrationRefresh: Promise<void> | null = null;
  const refreshManagedIntegrationsInBackground = (reason: string) => {
    // Only the app asks for this, when it opens: poll every account once at its normal
    // interval, and start the idle back-off again.
    autoSyncPacing.noteAppOpened(now());
    if (managedIntegrationRefresh) {
      return;
    }
    managedIntegrationRefresh = readModel
      .refreshLocalAccess({ maxAgeMs: 0 })
      .then((localAccess) =>
        refreshManagedIntegrationStates(db, {
          localIntegrationStates: localAccess.localIntegrationStates,
        }),
      )
      .then(() => {
        requestAllRealtimeReconciles();
        reconcileLocalWatchers();
        refreshMenuBarStatusNow(reason);
      })
      .catch((error) => {
        daemonLogger.warn("managed integration refresh failed", { reason, error });
      })
      .finally(() => {
        managedIntegrationRefresh = null;
      });
  };
  const requestContext: DaemonRequestContext = {
    db,
    telemetry,
    activeAuthSessions,
    schedulers,
    discordRealtime,
    slackRealtime,
    linkedInRealtime,
    signalRealtime,
    whatsAppRealtime,
    bootstrap,
    requestRealtimeReconcile: requestAllRealtimeReconciles,
    reconcileLocalWatchers,
    requestUpdateShutdown,
    isBackgroundWorkActive: () => isProcessingProjection() || activeIngestRuns.size > 0,
    onAuthRuntimeStateChanged: () => {
      requestAllRealtimeReconciles();
      schedulers.wakeProjection();
      refreshMenuBarStatusNow("auth_state_changed");
    },
    onAuthRuntimeProgress: () => notifySubscribers("status"),
    refreshStatusCacheNow: refreshMenuBarStatusNow,
    shouldRunRealtimePlatform,
    purgeAccountSyncRunHistory: (platform, accountKey, queuedBefore) =>
      syncRunMaintenance.purgeAccountHistory(platform, accountKey, queuedBefore),
    dbWorker,
    readModel,
    realtimeStatuses,
    subscribe,
    refreshManagedIntegrationsInBackground,
    recheckLocalAccessForManualSync,
    stallMonitor,
    noteForegroundRequest: () => {
      lastForegroundRequestAt = now();
    },
    discardMessageHooksForPlatform: (platform) => {
      projectionMessageHooks.discard(
        (payload) => (payload.message as { platform?: unknown } | undefined)?.platform === platform,
      );
    },
  };
  const server = createServer((socket) => {
    handleSocket(socket, requestContext);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(CUED_SOCKET_PATH, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // Watch for stalls from the moment requests can arrive. Opening the database and running
  // migrations before this point is synchronous by design, and nobody is waiting on it.
  stallMonitor.start();
  scheduleIngestDrain();
  scheduleProjectionDrain();
  scheduleSearchIndexDrain();
  setImmediate(() => {
    void runBootstrap();
  });

  const shutdown = async () => {
    if (shutdownInitiated) {
      return;
    }
    shutdownInitiated = true;
    daemonLogger.info("daemon shutting down", { pid: process.pid });
    clearInterval(heartbeat);
    statusHeartbeat.stop();
    clearInterval(schedulerLoop);
    for (const retry of autoSyncBusyRetries.values()) {
      clearTimeout(retry);
    }
    autoSyncBusyRetries.clear();
    clearInterval(updateLoop);
    updateArtifactRetention.stop();
    legacyBrowserProfileCleanup.stop();
    syncRunMaintenance.stop();
    stallMonitor.stop();
    if (walCheckpointTimer) {
      clearTimeout(walCheckpointTimer);
      walCheckpointTimer = null;
    }
    for (const subscriber of subscribers) {
      subscriber.destroy();
    }
    subscribers.clear();
    if (menuBarStatusWriteTimer) {
      clearTimeout(menuBarStatusWriteTimer);
      menuBarStatusWriteTimer = null;
    }
    stopProjectionDrain();
    stopSearchIndexDrain();
    if (ingestDrainTimer) {
      clearTimeout(ingestDrainTimer);
      ingestDrainTimer = null;
    }
    stopRealtimeAndWatchers();
    for (const session of activeAuthSessions.values()) {
      session.child.kill("SIGTERM");
    }
    activeAuthSessions.clear();
    projectionMessageHooks.clear();
    db.upsertDaemonState({
      pid: null,
      startedAt,
      updatedAt: now(),
      status: "stopped",
      version: DAEMON_VERSION,
      details: daemonIdentity,
    });
    server.close();
    await telemetry.close();
    readModel.close();
    await dbWorker.close();
    db.close();
    daemonLease.release();
    if (existsSync(CUED_SOCKET_PATH)) {
      rmSync(CUED_SOCKET_PATH, { force: true });
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function acquireDaemonLease() {
  const identity = getDaemonIdentity();
  try {
    return await acquireSingletonLock({
      path: CUED_DAEMON_LOCK_PATH,
      kind: "daemon",
      staleMs: SINGLETON_LOCK_STALE_MS,
      version: DAEMON_VERSION,
      executablePath: identity.executablePath,
      appPath: identity.appPath,
      probe: probeDaemonLockOwner,
    });
  } catch (error) {
    if (error instanceof SingletonLockHeldError) {
      const ownerPid = error.metadata?.pid;
      throw new Error(
        typeof ownerPid === "number" && ownerPid > 0
          ? `Cued daemon already running with pid ${ownerPid}`
          : "Cued daemon already running",
      );
    }
    throw error;
  }
}

async function probeDaemonLockOwner(
  _metadata: SingletonLockMetadata | null,
): Promise<"active" | "stale"> {
  return probeExistingSocket();
}

async function cleanupSocketPath(): Promise<void> {
  if (!existsSync(CUED_SOCKET_PATH)) {
    return;
  }

  const socketState = await probeExistingSocket();
  if (socketState === "active") {
    throw new Error(`Cued daemon already running on ${CUED_SOCKET_PATH}`);
  }

  rmSync(CUED_SOCKET_PATH, { force: true });
}

async function probeExistingSocket(): Promise<"active" | "stale"> {
  return new Promise((resolve) => {
    const socket = createConnection(CUED_SOCKET_PATH);
    let settled = false;
    let buffer = "";
    const timeout = setTimeout(() => {
      finish("stale");
    }, 500);

    const finish = (state: "active" | "stale") => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(state);
    };

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: "startup-probe", command: "ping" })}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }

      try {
        const response = JSON.parse(buffer.slice(0, newlineIndex)) as {
          ok?: boolean;
          result?: { pong?: boolean };
        };
        if (response.ok && response.result?.pong === true) {
          finish("active");
          return;
        }
      } catch {
        // Treat malformed responses as stale so we can recover the socket path.
      }

      finish("stale");
    });

    socket.on("error", () => {
      finish("stale");
    });
  });
}
