import process from "node:process";
import type { AdapterPlatform, Platform } from "../../core/types/provider.js";
import { isAdapterPlatform } from "../../platforms/core/registry.js";

const DEFAULT_AUTOSYNC_INTERVAL_MS = 60_000;
const DEFAULT_DISCORD_AUTOSYNC_INTERVAL_MS = 10 * 60_000;
const DEFAULT_SIGNAL_CATCHUP_INTERVAL_MS = 300_000;
const DEFAULT_WHATSAPP_CATCHUP_INTERVAL_MS = 300_000;
const DEFAULT_DISCORD_REALTIME_ENABLED = true;
const DEFAULT_DISCORD_DM_POLL_MS = 45_000;
const DEFAULT_SLACK_REALTIME_ENABLED = false;
const DEFAULT_INGEST_CONCURRENCY = 4;
const DEFAULT_PROJECTION_BATCH_SIZE = 100;
const DEFAULT_REALTIME_PROJECTION_ENABLED = true;
// Inline projection runs on the daemon thread, so it is reserved for the handful of events a
// realtime update or an incremental sync brings; anything larger goes to the worker process.
const DEFAULT_INLINE_PROJECTION_MAX_RAW_EVENTS = 10;
// Search indexing runs on the database worker (see search-index-drain), a pass at a time; the
// daemon hears back after each pass to report progress and schedule the next.
const FTS_INDEX_PASS_BUDGET_MS = 250;
const FTS_INDEX_SLICE_GAP_MS = 10;
const INGEST_INSERT_SLICE_EVENTS = 50;
const INGEST_INSERT_SLICE_BUDGET_MS = 10;
const DEFAULT_DEFERRED_PROJECTION_COALESCE_MS = 250;
const DEFAULT_AUTOSYNC_PROJECTION_BACKLOG_PAUSE_EVENTS = 5_000;
const DEFAULT_PROJECTION_CONTINUE_DELAY_MS = 5_000;
// How many events one projection worker invocation takes on, by backlog size. The worker
// commits every few dozen events regardless (see projectRangeInChunks), so a larger batch only
// means fewer process launches. Any backlog worth a worker continues immediately; the default
// delay applies only to a trickle too small to justify launching one per event.
const PROJECTION_BACKLOG_TIERS = [
  { minEvents: 100_000, batchSize: 2_000, continueDelayMs: 0 },
  { minEvents: 25_000, batchSize: 1_500, continueDelayMs: 0 },
  { minEvents: 5_000, batchSize: 1_000, continueDelayMs: 0 },
  { minEvents: 100, batchSize: 500, continueDelayMs: 0 },
] as const;
const FTS_PROJECTION_THROTTLE_BACKLOG_EVENTS = 0;
const FTS_PROJECTION_THROTTLE_DELAY_MS = 5_000;
const FTS_INDEXING_STALE_AFTER_MS = 5 * 60 * 1000;
const PROJECTION_RETRY_DELAY_MS = 5_000;
// The daemon's connection only checkpoints inline if the WAL reaches this many pages (~80 MB),
// which means the background checkpointer has stopped keeping up.
const WAL_BACKSTOP_AUTOCHECKPOINT_PAGES = 20_000;
const WAL_CHECKPOINT_POLL_MS = 1_000;
// With nothing written since the last look, the checkpoint poll backs off up to this interval.
// Any write brings it back to WAL_CHECKPOINT_POLL_MS at the next look.
const WAL_CHECKPOINT_IDLE_POLL_MAX_MS = 30_000;
const WAL_CHECKPOINT_MIN_CHANGED_ROWS = 200;
const WAL_CHECKPOINT_MAX_INTERVAL_MS = 10 * 60_000;
// Background cleanup waits this long after the last request before taking the write lock again.
const FOREGROUND_QUIET_PERIOD_MS = 2_000;
const DEFAULT_CONTINUATION_PROJECTION_INTERVAL_MS = 2_000;
const DEFAULT_CONTINUATION_PROJECTION_BACKLOG_EVENTS = 500;

const DEFAULT_AUTOSYNC_SCHEDULER_TICK_MS = 15_000;
const DEFAULT_SYNC_CONTINUE_DELAY_MS = 15_000;
const DEFAULT_SIGNAL_RECONNECT_SYNC_COOLDOWN_MS = 5 * 60_000;
const DAEMON_STATUS_BUSY_TIMEOUT_MS = 100;
// Jobs that run on a timer on the daemon thread never wait for the write lock. Every request
// waits behind whatever the thread is doing, so a job that finds a worker holding the lock
// skips at once and tries again TIMER_JOB_BUSY_RETRY_MS later instead.
const TIMER_JOB_BUSY_TIMEOUT_MS = 0;
const TIMER_JOB_BUSY_RETRY_MS = 1_000;
// How often the daemon refreshes its row in daemon_state and rewrites the menu bar status file
// when nothing else has. The app treats the row as live for 120 s (appDaemonHeartbeatGraceMs);
// the lock file, renewed every SINGLETON_LOCK_HEARTBEAT_MS, is what it checks first.
const DAEMON_STATUS_HEARTBEAT_MS = 60_000;
const MENU_BAR_STATUS_EVENT_DEBOUNCE_MS = 500;
const MENU_BAR_STATUS_EVENT_MIN_INTERVAL_MS = 5_000;
// The status file is rewritten on every change the daemon knows of and at least every
// DAEMON_STATUS_HEARTBEAT_MS, so a file younger than this is the daemon's current view.
const DAEMON_STATUS_CACHE_MAX_AGE_MS = DAEMON_STATUS_HEARTBEAT_MS + 30_000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_SHUTDOWN_GRACE_MS = 30_000;
// Well after startup, and after an update's helper has finished its health check.
const UPDATE_ARTIFACT_RETENTION_START_DELAY_MS = 10 * 60_000;
const UPDATE_ARTIFACT_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LEGACY_BROWSER_PROFILE_CLEANUP_RETRY_MS = 60 * 60_000;
const QUEUE_DRAIN_RETRY_DELAY_MS = 1_000;
const INGEST_RUN_LEASE_MS = 15 * 60_000;
const PROJECTION_WORKER_TIMEOUT_MS = 30 * 60_000;
const PROJECTION_RUN_LEASE_MS = PROJECTION_WORKER_TIMEOUT_MS + 5 * 60_000;
const WHATSAPP_ATTACHMENT_SESSION_WAIT_MS = 3_000;

function now(): number {
  return Date.now();
}

function getConfiguredRealtimePlatforms(): Set<AdapterPlatform> | null {
  const raw = process.env.CUED_REALTIME_PLATFORMS?.trim();
  if (!raw) {
    return null;
  }
  if (["0", "false", "none", "off"].includes(raw.toLowerCase())) {
    return new Set();
  }
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(isAdapterPlatform),
  );
}

function getAutoSyncIntervalMs(platform?: AdapterPlatform): number {
  if (platform) {
    const platformEnvName = `CUED_AUTOSYNC_INTERVAL_${platform.toUpperCase()}_MS`;
    const platformConfigured = Number(process.env[platformEnvName]);
    if (Number.isFinite(platformConfigured) && platformConfigured > 0) {
      return platformConfigured;
    }
  }

  const globalConfiguredRaw = process.env.CUED_AUTOSYNC_INTERVAL_MS;
  const globalConfigured = Number(globalConfiguredRaw);
  if (globalConfiguredRaw != null && Number.isFinite(globalConfigured) && globalConfigured > 0) {
    return globalConfigured;
  }

  if (platform === "signal") {
    return DEFAULT_SIGNAL_CATCHUP_INTERVAL_MS;
  }

  if (platform === "whatsapp") {
    return DEFAULT_WHATSAPP_CATCHUP_INTERVAL_MS;
  }

  if (platform === "discord") {
    return DEFAULT_DISCORD_AUTOSYNC_INTERVAL_MS;
  }

  return DEFAULT_AUTOSYNC_INTERVAL_MS;
}

function getAutoSyncSchedulerTickMs(): number {
  const configured = Number(process.env.CUED_AUTOSYNC_SCHEDULER_TICK_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.trunc(configured)
    : DEFAULT_AUTOSYNC_SCHEDULER_TICK_MS;
}

function isSqliteBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /sqlite_(busy|locked)|database is locked|database is busy/i.test(message);
}

function getIngestConcurrency(): number {
  const configured = Number(process.env.CUED_INGEST_CONCURRENCY ?? DEFAULT_INGEST_CONCURRENCY);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_INGEST_CONCURRENCY;
}

function getProjectionBatchSize(): number {
  const configured = Number(
    process.env.CUED_PROJECTION_BATCH_SIZE ?? DEFAULT_PROJECTION_BATCH_SIZE,
  );
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_PROJECTION_BATCH_SIZE;
}

function getRealtimeProjectionEnabled(): boolean {
  const configured = process.env.CUED_REALTIME_PROJECTION_ENABLED;
  if (configured == null) {
    return DEFAULT_REALTIME_PROJECTION_ENABLED;
  }

  return !["0", "false", "off", "no"].includes(configured.trim().toLowerCase());
}

function getSlackRealtimeEnabled(): boolean {
  const configured = process.env.CUED_SLACK_REALTIME_ENABLED;
  if (configured == null) {
    return DEFAULT_SLACK_REALTIME_ENABLED;
  }

  return !["0", "false", "off", "no"].includes(configured.trim().toLowerCase());
}

function getDiscordRealtimeEnabled(): boolean {
  const configured = process.env.CUED_DISCORD_REALTIME_ENABLED;
  if (configured == null) {
    return DEFAULT_DISCORD_REALTIME_ENABLED;
  }

  return !["0", "false", "off", "no"].includes(configured.trim().toLowerCase());
}

function getRealtimeProjectionBatchSize(): number {
  const configured = Number(
    process.env.CUED_REALTIME_PROJECTION_BATCH_SIZE ?? getProjectionBatchSize(),
  );
  return Number.isFinite(configured) && configured > 0 ? configured : getProjectionBatchSize();
}

function getSyncContinueDelayMs(): number {
  const configured = Number(process.env.CUED_SYNC_CONTINUE_DELAY_MS);
  return Number.isFinite(configured) && configured >= 0
    ? Math.trunc(configured)
    : DEFAULT_SYNC_CONTINUE_DELAY_MS;
}

function getSyncContinueDelayMsForPlatform(platform: Platform): number {
  if (platform === "imessage") {
    return 0;
  }
  return getSyncContinueDelayMs();
}

function getSignalReconnectSyncCooldownMs(): number {
  const configured = Number(process.env.CUED_SIGNAL_RECONNECT_SYNC_COOLDOWN_MS);
  return Number.isFinite(configured) && configured >= 0
    ? Math.trunc(configured)
    : DEFAULT_SIGNAL_RECONNECT_SYNC_COOLDOWN_MS;
}

function getDeferredProjectionCoalesceMs(): number {
  const configured = Number(
    process.env.CUED_DEFERRED_PROJECTION_COALESCE_MS ?? DEFAULT_DEFERRED_PROJECTION_COALESCE_MS,
  );
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_DEFERRED_PROJECTION_COALESCE_MS;
}

function getAutoSyncProjectionBacklogPauseEvents(): number {
  const configured = Number(process.env.CUED_AUTOSYNC_PROJECTION_BACKLOG_PAUSE_EVENTS);
  return Number.isFinite(configured) && configured >= 0
    ? Math.trunc(configured)
    : DEFAULT_AUTOSYNC_PROJECTION_BACKLOG_PAUSE_EVENTS;
}

function getProjectionContinueDelayMs(): number {
  const configured = Number(process.env.CUED_PROJECTION_CONTINUE_DELAY_MS);
  return Number.isFinite(configured) && configured >= 0
    ? Math.trunc(configured)
    : DEFAULT_PROJECTION_CONTINUE_DELAY_MS;
}

function getContinuationProjectionIntervalMs(): number {
  const configured = Number(process.env.CUED_CONTINUATION_PROJECTION_INTERVAL_MS);
  return Number.isFinite(configured) && configured >= 0
    ? Math.trunc(configured)
    : DEFAULT_CONTINUATION_PROJECTION_INTERVAL_MS;
}

function getContinuationProjectionBacklogEvents(): number {
  const configured = Number(process.env.CUED_CONTINUATION_PROJECTION_BACKLOG_EVENTS);
  return Number.isFinite(configured) && configured >= 0
    ? Math.trunc(configured)
    : DEFAULT_CONTINUATION_PROJECTION_BACKLOG_EVENTS;
}

function getWhatsAppResyncPageBudget(): number {
  const configured = Number(process.env.CUED_WHATSAPP_RESYNC_PAGE_BUDGET ?? 10);
  return Number.isFinite(configured) && configured > 0 ? Math.trunc(configured) : 10;
}

export {
  DAEMON_STATUS_BUSY_TIMEOUT_MS,
  DAEMON_STATUS_CACHE_MAX_AGE_MS,
  DAEMON_STATUS_HEARTBEAT_MS,
  DEFAULT_DISCORD_DM_POLL_MS,
  DEFAULT_INLINE_PROJECTION_MAX_RAW_EVENTS,
  FOREGROUND_QUIET_PERIOD_MS,
  FTS_INDEXING_STALE_AFTER_MS,
  FTS_INDEX_PASS_BUDGET_MS,
  FTS_INDEX_SLICE_GAP_MS,
  FTS_PROJECTION_THROTTLE_BACKLOG_EVENTS,
  FTS_PROJECTION_THROTTLE_DELAY_MS,
  INGEST_INSERT_SLICE_BUDGET_MS,
  INGEST_INSERT_SLICE_EVENTS,
  INGEST_RUN_LEASE_MS,
  LEGACY_BROWSER_PROFILE_CLEANUP_RETRY_MS,
  MENU_BAR_STATUS_EVENT_DEBOUNCE_MS,
  MENU_BAR_STATUS_EVENT_MIN_INTERVAL_MS,
  PROJECTION_BACKLOG_TIERS,
  PROJECTION_RETRY_DELAY_MS,
  PROJECTION_RUN_LEASE_MS,
  PROJECTION_WORKER_TIMEOUT_MS,
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
  WHATSAPP_ATTACHMENT_SESSION_WAIT_MS,
  getAutoSyncIntervalMs,
  getAutoSyncProjectionBacklogPauseEvents,
  getAutoSyncSchedulerTickMs,
  getConfiguredRealtimePlatforms,
  getContinuationProjectionBacklogEvents,
  getContinuationProjectionIntervalMs,
  getDeferredProjectionCoalesceMs,
  getDiscordRealtimeEnabled,
  getIngestConcurrency,
  getProjectionBatchSize,
  getProjectionContinueDelayMs,
  getRealtimeProjectionBatchSize,
  getRealtimeProjectionEnabled,
  getSignalReconnectSyncCooldownMs,
  getSlackRealtimeEnabled,
  getSyncContinueDelayMsForPlatform,
  getWhatsAppResyncPageBudget,
  isSqliteBusyError,
  now,
};
