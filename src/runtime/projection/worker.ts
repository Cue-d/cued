import type { QueuedSyncRun } from "../../db/database.js";
import { openCuedDatabase } from "../../db/database.js";
import { WRITE_LOCK_REST_MS } from "../../db/db-worker-jobs.js";
import {
  projectDeferredRange,
  projectPendingRawEvents,
  rebuildProjectedState,
} from "./projector.js";
import { parseProjectionRunDetails } from "./service.js";

export type ProjectionWorkerSuccess = {
  runId: string;
  runType: QueuedSyncRun["run_type"];
  projected: ReturnType<typeof projectDeferredRange> | ReturnType<typeof rebuildProjectedState>;
  timings: {
    projectionMs: number;
    totalMs: number;
  };
  projectionDetails: ReturnType<typeof parseProjectionRunDetails>;
  deferredProjected: ReturnType<typeof projectDeferredRange> | null;
  projectedRangeStart: number | null;
  projectedRangeEnd: number | null;
};

export type ProjectionWorkerMessage =
  | { ok: true; result: ProjectionWorkerSuccess }
  | { ok: false; error: string };

const TARGET_TRANSACTION_MS = 10;
const INITIAL_TRANSACTION_EVENTS = 10;
const MAX_TRANSACTION_EVENTS = 200;

function now(): number {
  return Date.now();
}

const restSignal = new Int32Array(new SharedArrayBuffer(4));

/** Blocks this (worker) process briefly; see WRITE_LOCK_REST_MS for why it must. */
function restFromWriteLock(ms: number): void {
  if (ms > 0) {
    Atomics.wait(restSignal, 0, 0, ms);
  }
}

/**
 * Projects up to `limit` events of a range in a series of short transactions.
 *
 * Projecting the whole batch in one transaction holds SQLite's write lock for the entire
 * batch, and the daemon's own writes are synchronous: a sign-in request or a status update
 * arriving meanwhile blocks the daemon, and everything queued behind it, until the batch
 * commits. So each transaction is sized to take about TARGET_TRANSACTION_MS, measured as it
 * goes: how long an event takes to project varies by more than an order of magnitude with the
 * size of the tables it touches, so a fixed event count is either too slow or far too long.
 * With the lock released every few milliseconds, and a short rest after each release so a
 * waiting writer actually gets it, the worker needs none of the batch-size and delay throttles
 * that used to protect the daemon from it.
 */
export function projectRangeInChunks(
  db: ReturnType<typeof openCuedDatabase>,
  range: { startRowId: number; endRowId: number },
  limit: number,
  tuning: {
    targetTransactionMs?: number;
    initialTransactionEvents?: number;
    maxTransactionEvents?: number;
    restMs?: number;
    clock?: () => number;
  } = {},
): ReturnType<typeof projectDeferredRange> {
  const targetMs = tuning.targetTransactionMs ?? TARGET_TRANSACTION_MS;
  const maxEvents = tuning.maxTransactionEvents ?? MAX_TRANSACTION_EVENTS;
  const clock = tuning.clock ?? (() => performance.now());
  let transactionEvents = Math.min(
    maxEvents,
    tuning.initialTransactionEvents ?? INITIAL_TRANSACTION_EVENTS,
  );
  let startRowId = range.startRowId;
  let remaining = Math.max(1, Math.trunc(limit));
  let appliedRawEvents = 0;
  for (;;) {
    const chunkLimit = Math.min(transactionEvents, remaining);
    const startedAt = clock();
    const chunk = projectDeferredRange(db, {
      startRowId,
      endRowId: range.endRowId,
      limit: chunkLimit,
      includeOverview: false,
    });
    const elapsedMs = clock() - startedAt;
    appliedRawEvents += chunk.appliedRawEvents;
    remaining -= chunkLimit;
    if (chunk.nextStartRowId == null || remaining <= 0) {
      return { ...chunk, appliedRawEvents, rangeStartRowId: range.startRowId };
    }
    startRowId = chunk.nextStartRowId;
    restFromWriteLock(tuning.restMs ?? WRITE_LOCK_REST_MS);
    // Steer toward the target, at most doubling per step so one fast chunk cannot overshoot.
    const scaled = elapsedMs > 0 ? (chunkLimit * targetMs) / elapsedMs : chunkLimit * 2;
    transactionEvents = Math.max(1, Math.min(maxEvents, chunkLimit * 2, Math.round(scaled)));
  }
}

export async function runProjectionWorker(run: QueuedSyncRun): Promise<ProjectionWorkerSuccess> {
  const db = openCuedDatabase();
  const projectionStartedAt = now();
  const runClaim = { ownerId: run.owner_id, attempt: run.attempt };
  try {
    const projectionDetails = parseProjectionRunDetails(run.details_json);
    const projectionBatchSize = Number(process.env.CUED_PROJECTION_BATCH_SIZE || "25");
    const projected =
      run.run_type === "rebuild"
        ? rebuildProjectedState(db, { limit: projectionBatchSize })
        : projectionDetails
          ? projectRangeInChunks(db, projectionDetails, projectionBatchSize)
          : (() => {
              const backlog = db.getProjectionBacklog();
              return backlog.pending_raw_events === 0
                ? projectPendingRawEvents(db, {
                    limit: projectionBatchSize,
                  })
                : projectRangeInChunks(
                    db,
                    {
                      startRowId: backlog.projection_watermark + 1,
                      endRowId: backlog.max_raw_event_rowid,
                    },
                    projectionBatchSize,
                  );
            })();
    const projectionFinishedAt = now();
    const timings = {
      projectionMs: projectionFinishedAt - projectionStartedAt,
      totalMs: projectionFinishedAt - projectionStartedAt,
    };
    const deferredProjected =
      run.run_type === "project" ? (projected as ReturnType<typeof projectDeferredRange>) : null;
    const finished = db.finishRun(
      run.id,
      {
        projected,
        timings,
        range: projectionDetails,
      },
      runClaim,
    );
    if (!finished) {
      throw new Error(`Projection run ${run.id} lost ownership before completion`);
    }
    const projectedRangeStart =
      deferredProjected?.rangeStartRowId ?? projectionDetails?.startRowId ?? null;
    const projectedRangeEnd =
      deferredProjected == null
        ? null
        : deferredProjected.nextStartRowId != null
          ? deferredProjected.nextStartRowId - 1
          : (deferredProjected.rangeEndRowId ?? projectionDetails?.endRowId ?? null);
    return {
      runId: run.id,
      runType: run.run_type,
      projected,
      timings,
      projectionDetails,
      deferredProjected,
      projectedRangeStart,
      projectedRangeEnd,
    };
  } catch (error) {
    db.failRun(
      run.id,
      error instanceof Error ? error.message : String(error),
      undefined,
      null,
      runClaim,
    );
    throw error;
  } finally {
    db.close();
  }
}

export async function runProjectionWorkerFromEnv(): Promise<void> {
  const runJson = process.env.CUED_PROJECTION_WORKER_RUN;
  if (!runJson) {
    throw new Error("CUED_PROJECTION_WORKER_RUN is required");
  }
  const run = JSON.parse(runJson) as QueuedSyncRun;
  try {
    const result = await runProjectionWorker(run);
    writeWorkerMessage({ ok: true, result });
  } catch (error) {
    writeWorkerMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

function writeWorkerMessage(message: ProjectionWorkerMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
