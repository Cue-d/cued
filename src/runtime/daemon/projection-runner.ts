import { spawn } from "node:child_process";
import process from "node:process";
import { createLogger } from "../../core/logging.js";
import type { CuedDatabase } from "../../db/database.js";
import { durationBucket, errorTelemetryProperties } from "../../telemetry/context.js";
import type { DaemonTelemetryQueue } from "../../telemetry/queue.js";
import {
  mergeProjectionRunDetails,
  type ProjectionMessageHookBarrier,
  type ProjectionRunDetails,
  parseProjectionRunDetails,
} from "../projection/service.js";
import type { ProjectionWorkerMessage, ProjectionWorkerSuccess } from "../projection/worker.js";
import type { DaemonBootstrapSnapshot } from "../status.js";
import { safeEmitHookEvent } from "./hook-events.js";
import {
  getAdaptiveProjectionBatchSize,
  getAdaptiveProjectionContinueDelayMs,
} from "./projection-scheduling.js";
import {
  DAEMON_STATUS_BUSY_TIMEOUT_MS,
  FTS_PROJECTION_THROTTLE_BACKLOG_EVENTS,
  FTS_PROJECTION_THROTTLE_DELAY_MS,
  isSqliteBusyError,
  now,
  PROJECTION_RETRY_DELAY_MS,
  PROJECTION_RUN_LEASE_MS,
  PROJECTION_WORKER_TIMEOUT_MS,
  QUEUE_DRAIN_RETRY_DELAY_MS,
  TIMER_JOB_BUSY_RETRY_MS,
  TIMER_JOB_BUSY_TIMEOUT_MS,
} from "./settings.js";
import type { StallMonitor } from "./stall-monitor.js";

const daemonLogger = createLogger("daemon");

function resolveCliEntrypoint(): string {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    throw new Error("Unable to resolve Cued CLI entrypoint for projection worker");
  }
  return entrypoint;
}

function runProjectionWorkerProcess(
  run: NonNullable<ReturnType<CuedDatabase["claimNextQueuedRun"]>>,
  projectionBatchSize: number,
): Promise<ProjectionWorkerSuccess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [resolveCliEntrypoint(), "__projection-worker"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CUED_PROJECTION_WORKER_RUN: JSON.stringify(run),
        CUED_PROJECTION_BATCH_SIZE: String(projectionBatchSize),
      },
      detached: false,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Projection worker timed out after ${PROJECTION_WORKER_TIMEOUT_MS}ms`));
    }, PROJECTION_WORKER_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const lines = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const lastLine = lines[lines.length - 1];
      let message: ProjectionWorkerMessage | null = null;
      if (lastLine) {
        try {
          message = JSON.parse(lastLine) as ProjectionWorkerMessage;
        } catch {
          message = null;
        }
      }

      if (message?.ok) {
        if (stderr.trim().length > 0) {
          daemonLogger.warn("projection worker stderr", { runId: run.id, stderr: stderr.trim() });
        }
        resolve(message.result);
        return;
      }

      const workerError =
        message && !message.ok
          ? message.error
          : `Projection worker exited with code ${code ?? "null"} signal ${signal ?? "null"}`;
      reject(
        new Error(stderr.trim().length > 0 ? `${workerError}\n${stderr.trim()}` : workerError),
      );
    });
  });
}

/** What the projection runner reads from the daemon that runs it. */
export type ProjectionRunnerDeps = {
  db: CuedDatabase;
  telemetry: DaemonTelemetryQueue;
  stallMonitor: StallMonitor;
  bootstrap: DaemonBootstrapSnapshot;
  runOwnerId: string;
  activeIngestRuns: Map<string, Promise<void>>;
  projectionMessageHooks: ProjectionMessageHookBarrier;
  deferredProjectionCoalesceMs: number;
  isUpdateShutdownRequested: () => boolean;
  scheduleSearchIndexDrain: (delayMs?: number) => void;
  requestMenuBarStatusWrite: (reason: string) => void;
  maybeFinishUpdateShutdown: () => void;
};

/**
 * Queues projection runs and works through them one at a time, each in a projection worker
 * process, releasing the message hooks for the rows each run projected.
 */
export function createProjectionRunner(deps: ProjectionRunnerDeps) {
  const {
    db,
    telemetry,
    stallMonitor,
    bootstrap,
    runOwnerId,
    activeIngestRuns,
    projectionMessageHooks,
    deferredProjectionCoalesceMs,
    isUpdateShutdownRequested,
    scheduleSearchIndexDrain,
    requestMenuBarStatusWrite,
    maybeFinishUpdateShutdown,
  } = deps;
  let isProcessingProjection = false;
  let projectionDrainScheduled = false;
  let projectionDrainTimer: NodeJS.Timeout | null = null;
  let projectionDrainDueAt: number | null = null;

  const drainProjectionQueue = () => {
    projectionDrainScheduled = false;
    projectionDrainDueAt = null;
    if (isUpdateShutdownRequested()) {
      return;
    }
    if (isProcessingProjection) {
      return;
    }
    if (bootstrap.state !== "ready") {
      scheduleProjectionDrain(QUEUE_DRAIN_RETRY_DELAY_MS);
      return;
    }

    let currentRun: ReturnType<typeof db.claimNextQueuedRun>;
    const claimableProjectionRunTypes =
      activeIngestRuns.size > 0 ? (["project"] as const) : (["project", "rebuild"] as const);
    try {
      currentRun = db.withBusyTimeoutSync(TIMER_JOB_BUSY_TIMEOUT_MS, () =>
        db.claimNextQueuedRun([...claimableProjectionRunTypes], "projecting", {
          ownerId: runOwnerId,
          leaseMs: PROJECTION_RUN_LEASE_MS,
        }),
      );
    } catch (error) {
      if (!isSqliteBusyError(error)) {
        throw error;
      }
      daemonLogger.warn("projection drain skipped because SQLite is busy");
      scheduleProjectionDrain(TIMER_JOB_BUSY_RETRY_MS);
      return;
    }
    if (!currentRun) {
      let nextScheduledAt: number | null = null;
      try {
        nextScheduledAt = db.withBusyTimeoutSync(TIMER_JOB_BUSY_TIMEOUT_MS, () =>
          db.getNextClaimableRunAt([...claimableProjectionRunTypes], "projecting"),
        );
      } catch (error) {
        if (!isSqliteBusyError(error)) {
          throw error;
        }
        daemonLogger.warn("projection drain skipped because SQLite is busy");
        scheduleProjectionDrain(TIMER_JOB_BUSY_RETRY_MS);
        return;
      }
      if (nextScheduledAt != null) {
        scheduleProjectionDrain(Math.max(QUEUE_DRAIN_RETRY_DELAY_MS, nextScheduledAt - now()));
      }
      return;
    }

    isProcessingProjection = true;
    requestMenuBarStatusWrite("projection_started");
    void processProjectionRun(currentRun);
  };

  const scheduleProjectionDrain = (delayMs = 0) => {
    const normalizedDelayMs = Math.max(0, delayMs);
    const dueAt = now() + normalizedDelayMs;
    if (projectionDrainScheduled) {
      if (projectionDrainDueAt != null && projectionDrainDueAt <= dueAt) {
        return;
      }
      if (projectionDrainTimer) {
        clearTimeout(projectionDrainTimer);
        projectionDrainTimer = null;
      }
    }
    projectionDrainScheduled = true;
    projectionDrainDueAt = dueAt;
    if (normalizedDelayMs <= 0) {
      setImmediate(drainProjectionQueue);
      return;
    }

    projectionDrainTimer = setTimeout(() => {
      projectionDrainTimer = null;
      stallMonitor.section("drain_projection_queue", drainProjectionQueue);
    }, normalizedDelayMs);
  };

  const queueProjectionRun = (
    trigger: string,
    range?: { startRowId: number; endRowId: number },
    options?: { delayMs?: number },
  ) => {
    if (isUpdateShutdownRequested()) {
      return null;
    }
    try {
      return db.withBusyTimeoutSync(DAEMON_STATUS_BUSY_TIMEOUT_MS, () => {
        const backlog = db.getProjectionBacklog();
        const incomingDetails = mergeProjectionRunDetails({
          existing: null,
          incoming: {
            trigger,
            startRowId: range?.startRowId ?? backlog.projection_watermark + 1,
            endRowId: range?.endRowId ?? backlog.max_raw_event_rowid,
          },
          projectionWatermark: backlog.projection_watermark,
          maxRawEventRowid: backlog.max_raw_event_rowid,
        });

        const queuedProjectionRun = db.getQueuedProjectionRun();
        if (queuedProjectionRun) {
          const projectionDelayMs = options?.delayMs ?? deferredProjectionCoalesceMs;
          const projectionScheduledAt = now() + Math.max(0, Math.trunc(projectionDelayMs));
          const existingDetails = parseProjectionRunDetails(queuedProjectionRun.details_json);
          const mergedDetails =
            incomingDetails == null
              ? existingDetails
                ? mergeProjectionRunDetails({
                    existing: null,
                    incoming: existingDetails,
                    projectionWatermark: backlog.projection_watermark,
                    maxRawEventRowid: backlog.max_raw_event_rowid,
                  })
                : null
              : mergeProjectionRunDetails({
                  existing: existingDetails,
                  incoming: incomingDetails,
                  projectionWatermark: backlog.projection_watermark,
                  maxRawEventRowid: backlog.max_raw_event_rowid,
                });
          if (mergedDetails) {
            db.updateRunDetails(
              queuedProjectionRun.id,
              mergedDetails satisfies ProjectionRunDetails,
            );
          }
          if (projectionScheduledAt < queuedProjectionRun.scheduled_at) {
            db.rescheduleRun(queuedProjectionRun.id, projectionScheduledAt);
          }
          scheduleProjectionDrain(projectionDelayMs);
          return queuedProjectionRun.id;
        }

        if (!incomingDetails) {
          return null;
        }

        const runId = db.queueSyncRun({
          runType: "project",
          trigger,
          delayMs: options?.delayMs ?? deferredProjectionCoalesceMs,
          details: incomingDetails satisfies ProjectionRunDetails,
        });
        scheduleProjectionDrain(options?.delayMs ?? deferredProjectionCoalesceMs);
        return runId;
      });
    } catch (error) {
      if (!isSqliteBusyError(error)) {
        throw error;
      }
      daemonLogger.warn("projection queue skipped because SQLite is busy", { trigger });
      return null;
    }
  };

  const processProjectionRun = async (
    currentRun: NonNullable<ReturnType<typeof db.claimNextQueuedRun>>,
  ) => {
    const runClaim = { ownerId: currentRun.owner_id, attempt: currentRun.attempt };
    try {
      const projectionBacklogBeforeRun = db.withBusyTimeoutSync(DAEMON_STATUS_BUSY_TIMEOUT_MS, () =>
        db.getProjectionBacklog(),
      );
      const adaptiveProjectionBatchSize = getAdaptiveProjectionBatchSize(
        projectionBacklogBeforeRun.pending_raw_events,
      );
      daemonLogger.info("projection run started", {
        runId: currentRun.id,
        trigger: currentRun.trigger,
        runType: currentRun.run_type,
        pendingRawEvents: projectionBacklogBeforeRun.pending_raw_events,
        projectionBatchSize: adaptiveProjectionBatchSize,
      });
      db.updateRunProgress(currentRun.id, { leaseMs: PROJECTION_RUN_LEASE_MS, claim: runClaim });
      telemetry.enqueue("sync_started", {
        component: "sync",
        operation: "projection",
        stage: "projection",
        run_id: currentRun.id,
        run_type: currentRun.run_type,
        trigger: currentRun.trigger,
      });
      db.updateRunProgress(currentRun.id, { leaseMs: PROJECTION_RUN_LEASE_MS, claim: runClaim });
      const workerResult = await runProjectionWorkerProcess(
        currentRun,
        adaptiveProjectionBatchSize,
      );
      db.updateRunProgress(currentRun.id, { leaseMs: PROJECTION_RUN_LEASE_MS, claim: runClaim });
      const {
        projected,
        timings,
        projectionDetails,
        deferredProjected,
        projectedRangeStart,
        projectedRangeEnd,
      } = workerResult;
      if (currentRun.run_type === "rebuild") {
        await projectionMessageHooks.releaseAll(async (payload) => {
          await safeEmitHookEvent("message.received", payload);
        });
      }
      if (
        currentRun.run_type !== "rebuild" &&
        projectedRangeStart != null &&
        projectedRangeEnd != null &&
        projectedRangeEnd >= projectedRangeStart
      ) {
        await projectionMessageHooks.releaseCompletedRange(
          {
            startRowId: projectedRangeStart,
            endRowId: projectedRangeEnd,
          },
          async (payload) => {
            await safeEmitHookEvent("message.received", payload);
          },
        );
      }
      if (deferredProjected?.nextStartRowId != null) {
        const remainingProjectionEvents = Math.max(
          0,
          (deferredProjected.rangeEndRowId ??
            projectionDetails?.endRowId ??
            deferredProjected.projectionWatermark) - deferredProjected.projectionWatermark,
        );
        queueProjectionRun(
          `projection_continue:${currentRun.id}`,
          {
            startRowId: deferredProjected.nextStartRowId,
            endRowId:
              deferredProjected.rangeEndRowId ??
              projectionDetails?.endRowId ??
              deferredProjected.projectionWatermark,
          },
          { delayMs: getAdaptiveProjectionContinueDelayMs(remainingProjectionEvents) },
        );
      }
      const projectionBacklogAfterRun = db.getProjectionBacklog();
      queueProjectionRun(`projection:${currentRun.run_type}`, undefined, {
        delayMs: getAdaptiveProjectionContinueDelayMs(projectionBacklogAfterRun.pending_raw_events),
      });
      await safeEmitHookEvent("sync.completed", {
        runId: currentRun.id,
        platform: currentRun.platform,
        runType: currentRun.run_type,
        stage: "projection",
        projected,
        timings,
      });
      telemetry.enqueue("sync_completed", {
        component: "sync",
        operation: "projection",
        stage: "projection",
        run_id: currentRun.id,
        run_type: currentRun.run_type,
        trigger: currentRun.trigger,
        duration_bucket: durationBucket(timings.totalMs),
      });
      daemonLogger.info("projection run completed", {
        runId: currentRun.id,
        runType: currentRun.run_type,
        totalMs: timings.totalMs,
        appliedRawEvents: projected.appliedRawEvents,
        pendingRawEvents: projectionBacklogAfterRun.pending_raw_events,
        projectionBatchSize: adaptiveProjectionBatchSize,
      });
      requestMenuBarStatusWrite("projection_completed");
      scheduleSearchIndexDrain(
        projectionBacklogAfterRun.pending_raw_events > FTS_PROJECTION_THROTTLE_BACKLOG_EVENTS
          ? FTS_PROJECTION_THROTTLE_DELAY_MS
          : 0,
      );
    } catch (error) {
      daemonLogger.error("projection run failed", {
        runId: currentRun.id,
        runType: currentRun.run_type,
        error: error instanceof Error ? error.message : String(error),
      });
      db.failRun(
        currentRun.id,
        error instanceof Error ? error.message : String(error),
        undefined,
        null,
        runClaim,
      );
      telemetry.enqueue("sync_failed", {
        component: "sync",
        operation: "projection",
        stage: "projection",
        run_id: currentRun.id,
        run_type: currentRun.run_type,
        trigger: currentRun.trigger,
        ...errorTelemetryProperties(error, "projection_failed"),
      });
      await safeEmitHookEvent("sync.failed", {
        runId: currentRun.id,
        platform: currentRun.platform,
        runType: currentRun.run_type,
        stage: "projection",
        error: error instanceof Error ? error.message : String(error),
      });
      // A failed run used to leave its backlog stranded until some unrelated sync happened to
      // queue another projection. Queue the retry ourselves (a no-op when nothing is pending).
      if (currentRun.run_type === "project") {
        queueProjectionRun(`projection_retry:${currentRun.id}`, undefined, {
          delayMs: PROJECTION_RETRY_DELAY_MS,
        });
      }
    } finally {
      isProcessingProjection = false;
      scheduleProjectionDrain();
      maybeFinishUpdateShutdown();
    }
  };

  const stopProjectionDrain = () => {
    if (projectionDrainTimer) {
      clearTimeout(projectionDrainTimer);
      projectionDrainTimer = null;
    }
  };

  return {
    scheduleProjectionDrain,
    queueProjectionRun,
    isProcessingProjection: () => isProcessingProjection,
    stopProjectionDrain,
  };
}
