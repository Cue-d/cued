import type {
  AdapterPlatform,
  Platform,
  ProviderRawEventInput,
} from "../../core/types/provider.js";
import { safeParseJsonRecord } from "../../db/codecs.js";
import type { QueuedSyncRun } from "../../db/database.js";
import { openCuedDatabase } from "../../db/database.js";
import { buildAdapterInvocationEnv } from "../../platforms/core/invocation.js";
import { runAdapter } from "../../platforms/core/runner.js";
import type { SyncContinuation } from "../../platforms/core/sync.js";
import type { ProjectionRunDetails } from "../projection/service.js";
import { mergeProjectionRunDetails, parseProjectionRunDetails } from "../projection/service.js";

type IMessageIngestWorkerOptions = {
  syncContinueDelayMs: number;
  deferredProjectionCoalesceMs: number;
};

type IngestTiming = {
  adapterFetchMs: number;
  rawEventInsertMs: number;
  realtimeProjectionMs: number;
  checkpointUpdateMs: number;
  webhookReadyMs: number;
  totalMs: number;
  insertedRawEvents: number;
};

export type IMessageIngestWorkerSuccess = {
  runId: string;
  platform: "imessage";
  accountKey: string;
  runType: "sync" | "sync_resume";
  ingested: number;
  insertedRawEvents: number;
  insertedRawEventSchemas?: Record<string, number>;
  hasMore: boolean;
  syncMode: "full" | "incremental";
  projectionQueued: boolean;
  timings: IngestTiming;
  continuation?: SyncContinuation;
  diagnostics?: Record<string, unknown>;
};

export type IMessageIngestWorkerMessage =
  | { ok: true; result: IMessageIngestWorkerSuccess }
  | { ok: false; error: string };

function now(): number {
  return Date.now();
}

function resolveCheckpointSyncMode(
  runType: "sync" | "sync_resume",
  priorSyncMode: string | null | undefined,
  bundleSyncMode: string | null | undefined,
  hasMore: boolean,
): "full" | "incremental" {
  if (hasMore) {
    return "full";
  }

  if (runType === "sync_resume" || priorSyncMode === "full") {
    return "incremental";
  }

  return bundleSyncMode === "incremental" ? "incremental" : "full";
}

function withRawEventAcquisitionMode(rawEvents: ProviderRawEventInput[]): ProviderRawEventInput[] {
  return rawEvents.map((rawEvent) => ({
    ...rawEvent,
    provenance: {
      ...(rawEvent.provenance ?? {}),
      acquisitionMode: "sync",
    },
  }));
}

function summarizeRawEventsBySchema(
  rawEvents: ProviderRawEventInput[],
): Record<string, number> | undefined {
  if (rawEvents.length === 0) {
    return undefined;
  }

  const entries = new Map<string, number>();
  for (const rawEvent of rawEvents) {
    const key =
      typeof rawEvent.normalizedSchema === "string" && rawEvent.normalizedSchema.length > 0
        ? rawEvent.normalizedSchema
        : `${rawEvent.entityKind}.${rawEvent.eventKind}`;
    entries.set(key, (entries.get(key) ?? 0) + 1);
  }

  return Object.fromEntries(
    [...entries.entries()].sort((left, right) =>
      left[0] === right[0] ? 0 : left[0] < right[0] ? -1 : 1,
    ),
  );
}

function queueProjectionRun(
  db: ReturnType<typeof openCuedDatabase>,
  trigger: string,
  delayMs: number,
): string | null {
  const backlog = db.getProjectionBacklog();
  const incomingDetails = mergeProjectionRunDetails({
    existing: null,
    incoming: {
      trigger,
      startRowId: backlog.projection_watermark + 1,
      endRowId: backlog.max_raw_event_rowid,
    },
    projectionWatermark: backlog.projection_watermark,
    maxRawEventRowid: backlog.max_raw_event_rowid,
  });
  const queuedProjectionRun = db.getQueuedProjectionRun();
  if (queuedProjectionRun) {
    const existingDetails = parseProjectionRunDetails(queuedProjectionRun.details_json);
    const mergedDetails =
      incomingDetails == null
        ? existingDetails
        : mergeProjectionRunDetails({
            existing: existingDetails,
            incoming: incomingDetails,
            projectionWatermark: backlog.projection_watermark,
            maxRawEventRowid: backlog.max_raw_event_rowid,
          });
    if (mergedDetails) {
      db.updateRunDetails(queuedProjectionRun.id, mergedDetails satisfies ProjectionRunDetails);
    }
    return queuedProjectionRun.id;
  }

  if (!incomingDetails) {
    return null;
  }

  return db.queueSyncRun({
    runType: "project",
    trigger,
    delayMs,
    details: incomingDetails satisfies ProjectionRunDetails,
  });
}

function assertIMessageRun(
  run: QueuedSyncRun,
): asserts run is QueuedSyncRun & { platform: "imessage"; run_type: "sync" | "sync_resume" } {
  if (run.platform !== "imessage" || (run.run_type !== "sync" && run.run_type !== "sync_resume")) {
    throw new Error(`Unsupported iMessage ingest worker run: ${run.run_type}:${run.platform}`);
  }
}

export async function runIMessageIngestWorker(
  run: QueuedSyncRun,
  options: IMessageIngestWorkerOptions,
): Promise<IMessageIngestWorkerSuccess> {
  assertIMessageRun(run);

  const db = openCuedDatabase();
  const ingestStartedAt = now();
  try {
    const platform: AdapterPlatform & Platform = "imessage";
    const accountKey = run.account_key ?? "local";
    const checkpoint = db.getCheckpoint(platform, accountKey);
    const sourceCursor = safeParseJsonRecord(
      checkpoint?.source_cursor_json ?? null,
      "sync_checkpoints.source_cursor_json",
    );
    const envOverrides = buildAdapterInvocationEnv({
      platform,
      checkpointSourceCursorJson: checkpoint?.source_cursor_json ?? null,
      proofs: db.listSyncProofs(platform, accountKey).filter((proof) => proof.status === "running"),
    });

    const adapterStartedAt = now();
    const bundle = await runAdapter(platform, accountKey, envOverrides);
    const adapterFetchMs = now() - adapterStartedAt;
    const bundleSourceCursor =
      (bundle.sourceCursor as Record<string, unknown> | undefined | null) ?? null;
    const bundleSyncMode =
      bundle.syncMode ?? (checkpoint?.source_cursor_json ? "incremental" : "full");
    const bundleHasMore = bundle.hasMore ?? false;
    const bundleContinuation = bundle.continuation ?? null;
    const bundleDiagnostics =
      bundle.diagnostics && Object.keys(bundle.diagnostics).length > 0 ? bundle.diagnostics : null;
    const ingestedCount = bundle.rawEvents.length;

    const rawEventInsertStartedAt = now();
    const insertResult = db.withBusyTimeoutSync(10_000, () =>
      db.insertRawEvents(withRawEventAcquisitionMode(bundle.rawEvents)),
    );
    const rawEventInsertMs = now() - rawEventInsertStartedAt;
    const insertedRawEventSchemas = summarizeRawEventsBySchema(insertResult.insertedEvents);
    const checkpointSyncMode = resolveCheckpointSyncMode(
      run.run_type,
      checkpoint?.sync_mode,
      bundleSyncMode,
      bundleHasMore,
    );
    const checkpointStartedAt = now();
    db.withBusyTimeoutSync(10_000, () => {
      db.upsertSourceAccounts(bundle.sourceAccounts);
      const projection = db.getProjectionBacklog();
      db.upsertCheckpoint({
        platform,
        accountKey,
        syncMode: checkpointSyncMode,
        sourceCursor: bundleSourceCursor,
        rawIngestWatermark: projection.max_raw_event_rowid,
        lastSuccessAt: now(),
      });
    });
    const afterCheckpoint = now();

    let projectionQueued = false;
    const projection = db.getProjectionBacklog();
    if (projection.pending_raw_events > 0) {
      projectionQueued = Boolean(
        db.withBusyTimeoutSync(10_000, () =>
          queueProjectionRun(
            db,
            `ingest:${platform}:${accountKey}`,
            options.deferredProjectionCoalesceMs,
          ),
        ),
      );
    }

    const timings: IngestTiming = {
      adapterFetchMs,
      rawEventInsertMs,
      realtimeProjectionMs: 0,
      checkpointUpdateMs: afterCheckpoint - checkpointStartedAt,
      webhookReadyMs: afterCheckpoint - ingestStartedAt,
      totalMs: now() - ingestStartedAt,
      insertedRawEvents: insertResult.insertedCount,
    };

    const result: IMessageIngestWorkerSuccess = {
      runId: run.id,
      platform,
      accountKey,
      runType: run.run_type,
      ingested: ingestedCount,
      insertedRawEvents: insertResult.insertedCount,
      insertedRawEventSchemas,
      hasMore: bundleHasMore,
      syncMode: checkpointSyncMode,
      projectionQueued,
      timings,
      ...(bundleContinuation ? { continuation: bundleContinuation } : {}),
      ...(bundleDiagnostics ? { diagnostics: bundleDiagnostics } : {}),
    };

    db.finishRun(run.id, {
      ingested: result.ingested,
      insertedRawEvents: result.insertedRawEvents,
      projectionQueued: result.projectionQueued,
      hasMore: result.hasMore,
      syncMode: result.syncMode,
      timings: result.timings,
      ...(result.continuation ? { continuation: result.continuation } : {}),
      ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
    });

    if (bundleHasMore && !db.hasQueuedOrRunningRun(platform, accountKey)) {
      db.withBusyTimeoutSync(10_000, () => {
        db.queueSyncRun({
          platform,
          accountKey,
          runType: "sync_resume",
          trigger: "ingest_continue",
          delayMs: options.syncContinueDelayMs,
          details: {
            source: platform,
            accountKey,
            trigger: "ingest_continue",
            ...(bundleContinuation ? { continuation: bundleContinuation } : {}),
            priorSourceCursor: sourceCursor,
          },
        });
      });
    }

    return result;
  } catch (error) {
    db.failRun(run.id, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    db.close();
  }
}

export async function runIMessageIngestWorkerFromEnv(): Promise<void> {
  const runJson = process.env.CUED_IMESSAGE_INGEST_WORKER_RUN;
  if (!runJson) {
    throw new Error("CUED_IMESSAGE_INGEST_WORKER_RUN is required");
  }

  const syncContinueDelayMs = Number(process.env.CUED_SYNC_CONTINUE_DELAY_MS || "15000");
  const deferredProjectionCoalesceMs = Number(
    process.env.CUED_DEFERRED_PROJECTION_COALESCE_MS || "5000",
  );
  const run = JSON.parse(runJson) as QueuedSyncRun;
  try {
    const result = await runIMessageIngestWorker(run, {
      syncContinueDelayMs: Number.isFinite(syncContinueDelayMs) ? syncContinueDelayMs : 15_000,
      deferredProjectionCoalesceMs: Number.isFinite(deferredProjectionCoalesceMs)
        ? deferredProjectionCoalesceMs
        : 5_000,
    });
    writeWorkerMessage({ ok: true, result });
  } catch (error) {
    writeWorkerMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

function writeWorkerMessage(message: IMessageIngestWorkerMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
