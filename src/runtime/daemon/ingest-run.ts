import { isAdapterWorkerError } from "../../platforms/core/runner.js";

type IngestTiming = {
  adapterFetchMs: number;
  rawEventInsertMs: number;
  realtimeProjectionMs: number;
  checkpointUpdateMs: number;
  webhookReadyMs: number;
  totalMs: number;
  insertedRawEvents: number;
};

export function isAdapterAuthInvalidation(
  platform: string | null,
  error: unknown,
): platform is "linkedin" | "slack" | "gmail" {
  return (
    (platform === "linkedin" || platform === "slack" || platform === "gmail") &&
    isAdapterWorkerError(error, "auth_invalid")
  );
}

/**
 * The run this ingest belongs to no longer exists or is no longer ours: the source was reset,
 * or the lease was reclaimed. Whatever it fetched must not be recorded as progress.
 */
export class IngestRunSupersededError extends Error {
  constructor(runId: string) {
    super(`Ingest run ${runId} was superseded`);
    this.name = "IngestRunSupersededError";
  }
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

export { resolveCheckpointSyncMode, type IngestTiming };
