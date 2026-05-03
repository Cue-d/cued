import type { QueuedSyncRun } from "../../db/database.js";
import { openCuedDatabase } from "../../db/database.js";
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

function now(): number {
  return Date.now();
}

export async function runProjectionWorker(run: QueuedSyncRun): Promise<ProjectionWorkerSuccess> {
  const db = openCuedDatabase();
  const projectionStartedAt = now();
  try {
    const projectionDetails = parseProjectionRunDetails(run.details_json);
    const projected =
      run.run_type === "rebuild"
        ? rebuildProjectedState(db)
        : projectionDetails
          ? projectDeferredRange(db, {
              startRowId: projectionDetails.startRowId,
              endRowId: projectionDetails.endRowId,
              limit: Number(process.env.CUED_PROJECTION_BATCH_SIZE || "25"),
              includeOverview: false,
            })
          : (() => {
              const backlog = db.getProjectionBacklog();
              return backlog.pending_raw_events === 0
                ? projectPendingRawEvents(db, {
                    limit: Number(process.env.CUED_PROJECTION_BATCH_SIZE || "25"),
                  })
                : projectDeferredRange(db, {
                    startRowId: backlog.projection_watermark + 1,
                    endRowId: backlog.max_raw_event_rowid,
                    limit: Number(process.env.CUED_PROJECTION_BATCH_SIZE || "25"),
                    includeOverview: false,
                  });
            })();
    const projectionFinishedAt = now();
    const timings = {
      projectionMs: projectionFinishedAt - projectionStartedAt,
      totalMs: projectionFinishedAt - projectionStartedAt,
    };
    const deferredProjected =
      run.run_type === "project" ? (projected as ReturnType<typeof projectDeferredRange>) : null;
    db.finishRun(run.id, {
      projected,
      timings,
      range: projectionDetails,
    });
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
    db.failRun(run.id, error instanceof Error ? error.message : String(error));
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
