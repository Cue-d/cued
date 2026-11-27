import process from "node:process";
import type { Platform } from "../../core/types/provider.js";
import {
  DEFAULT_INLINE_PROJECTION_MAX_RAW_EVENTS,
  getContinuationProjectionBacklogEvents,
  getContinuationProjectionIntervalMs,
  getProjectionBatchSize,
  getProjectionContinueDelayMs,
  PROJECTION_BACKLOG_TIERS,
} from "./settings.js";

export function shouldProjectIngestRunInline(input: {
  platform: Platform;
  runType: "sync" | "sync_resume";
  realtimeProjectionEnabled: boolean;
  firstInsertedRowId: number | null;
  lastInsertedRowId: number | null;
  insertedRawEvents: number;
}): boolean {
  return (
    input.platform !== "discord" &&
    input.runType !== "sync_resume" &&
    input.realtimeProjectionEnabled &&
    input.firstInsertedRowId != null &&
    input.lastInsertedRowId != null &&
    input.insertedRawEvents > 0 &&
    input.insertedRawEvents <= DEFAULT_INLINE_PROJECTION_MAX_RAW_EVENTS
  );
}

export function getAdaptiveProjectionBatchSize(pendingRawEvents: number): number {
  const baseBatchSize = getProjectionBatchSize();
  const tier = PROJECTION_BACKLOG_TIERS.find(
    (candidate) => pendingRawEvents >= candidate.minEvents,
  );
  return Math.max(baseBatchSize, tier?.batchSize ?? baseBatchSize);
}

export function getAdaptiveProjectionContinueDelayMs(pendingRawEvents: number): number {
  const configured = process.env.CUED_PROJECTION_CONTINUE_DELAY_MS;
  if (configured != null) {
    return getProjectionContinueDelayMs();
  }
  const tier = PROJECTION_BACKLOG_TIERS.find(
    (candidate) => pendingRawEvents >= candidate.minEvents && candidate.continueDelayMs != null,
  );
  return tier?.continueDelayMs ?? getProjectionContinueDelayMs();
}

export function shouldDeferContinuationProjection(input: {
  hasMore: boolean;
  pendingRawEvents: number;
  lastProjectionQueuedAt: number;
  nowMs: number;
  intervalMs?: number;
  backlogEvents?: number;
}): boolean {
  const intervalMs = input.intervalMs ?? getContinuationProjectionIntervalMs();
  const backlogEvents = input.backlogEvents ?? getContinuationProjectionBacklogEvents();
  return (
    input.hasMore &&
    input.pendingRawEvents > 0 &&
    input.pendingRawEvents < backlogEvents &&
    input.nowMs - input.lastProjectionQueuedAt < intervalMs
  );
}
