import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  type FSWatcher,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { basename, dirname } from "node:path";
import process from "node:process";
import { getCurrentAppVersion, getCurrentReleaseChannel } from "../../core/app-metadata.js";
import {
  CUED_DAEMON_LOCK_PATH,
  CUED_MENU_BAR_STATUS_PATH,
  CUED_SOCKET_PATH,
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
  type AdapterPlatform,
  getDefaultAccountKeyForPlatform,
  type HostOS,
  isPlatform,
  type Platform,
  type ProviderRawEventInput,
  type RawEventAcquisitionMode,
} from "../../core/types/provider.js";
import { safeParseJsonRecord, safeParseJsonStringArray } from "../../db/codecs.js";
import { type CuedDatabase, type OutboundMessageRow, openCuedDatabase } from "../../db/database.js";
import {
  buildAdapterInvocationEnv,
  selectAdapterInvocationProofs,
} from "../../platforms/core/invocation.js";
import { isAdapterPlatform, listAutoSyncPlatforms } from "../../platforms/core/registry.js";
import { runAdapter } from "../../platforms/core/runner.js";
import { loadIntegrationSecret } from "../../platforms/core/secrets/keychain.js";
import { refreshLocalIntegrationStates } from "../../platforms/core/state/local-refresh.js";
import { refreshManagedIntegrationStates } from "../../platforms/core/state/refresh.js";
import { getIntegrationSummary } from "../../platforms/core/state/status.js";
import type { SyncContinuation } from "../../platforms/core/sync.js";
import {
  DiscordApiClient,
  isDiscordAuthInvalidationError,
} from "../../platforms/discord/api/client.js";
import {
  type DiscordRealtimeEventEnvelope,
  type DiscordRealtimeStatus,
  DiscordRealtimeSupervisor,
} from "../../platforms/discord/realtime/session.js";
import {
  buildDiscordContactEvent,
  buildDiscordConversationEvent,
  buildDiscordMessageEvent,
} from "../../platforms/discord/sync/events.js";
import { isDiscordDmChannel } from "../../platforms/discord/types.js";
import { DEFAULT_CALL_HISTORY_DB_PATH } from "../../platforms/imessage/call-history.js";
import { DEFAULT_CHAT_DB_PATH } from "../../platforms/imessage/reader.js";
import { loadLinkedInSessionSecret } from "../../platforms/linkedin/auth/session-store.js";
import { buildLinkedInRawEventsFromRealtimeEnvelope } from "../../platforms/linkedin/realtime/events.js";
import {
  type LinkedInRealtimeStatus,
  LinkedInRealtimeSupervisor,
} from "../../platforms/linkedin/realtime/session.js";
import {
  getSignalConfigDir,
  inspectSignalCli,
  isSignalCliVersionSupported,
  readSignalLinkedAccount,
} from "../../platforms/signal/cli/binary.js";
import { SignalCliClient } from "../../platforms/signal/cli/client.js";
import {
  type SignalRealtimeStatus,
  SignalRealtimeSupervisor,
} from "../../platforms/signal/realtime/session.js";
import { buildSignalRawEventsFromMessages } from "../../platforms/signal/sync/events.js";
import { inspectSlackHelper } from "../../platforms/slack/helper/binary.js";
import {
  type SlackRealtimeEventEnvelope,
  type SlackRealtimeStatus,
  SlackRealtimeSupervisor,
} from "../../platforms/slack/realtime/session.js";
import {
  buildSlackContactEvents,
  buildSlackConversationEvent,
  buildSlackMessageEvents,
} from "../../platforms/slack/sync/events.js";
import {
  getWhatsAppStoreDir,
  inspectWhatsAppHelper,
} from "../../platforms/whatsapp/helper/binary.js";
import { readWhatsAppHelperStatus } from "../../platforms/whatsapp/helper/status.js";
import {
  type WhatsAppRealtimeStatus,
  WhatsAppRealtimeSupervisor,
} from "../../platforms/whatsapp/realtime/session.js";
import { buildWhatsAppRawEventsFromSnapshot } from "../../platforms/whatsapp/sync/events.js";
import {
  addWhatsAppResyncStats,
  buildWhatsAppMessagesProof,
  emptyWhatsAppResyncStats,
  mergeWhatsAppResyncCoverage,
  parseWhatsAppSourceCursor,
  summarizeWhatsAppMessageCoverage,
} from "../../platforms/whatsapp/sync/proof.js";
import type {
  WhatsAppHelperEventEnvelope,
  WhatsAppReceiptSnapshot,
  WhatsAppSnapshot,
} from "../../platforms/whatsapp/types.js";
import { fetchAttachment, listAttachments, searchAttachments } from "../attachments.js";
import { buildPermissionStatus } from "../doctor.js";
import { emitHookEvent } from "../hooks.js";
import type { DaemonRequest, DaemonResponse } from "../ipc.js";
import { collectInboundMessageHookPayloads } from "../message-hooks.js";
import { resolveMacOSNativeBinary } from "../native-binary.js";
import { projectRealtimeRange } from "../projection/projector.js";
import {
  buildProjectionMessageHookBatches,
  mergeProjectionRunDetails,
  ProjectionMessageHookBarrier,
  type ProjectionMessageHookPayload,
  type ProjectionRunDetails,
  parseProjectionRunDetails,
} from "../projection/service.js";
import type { ProjectionWorkerMessage, ProjectionWorkerSuccess } from "../projection/worker.js";
import { RunQueueService } from "../run-queue.js";
import {
  buildDaemonStatusSnapshot,
  buildDoctorSnapshot,
  buildMenuBarDaemonStatusSnapshot,
  type DaemonBootstrapSnapshot,
} from "../status.js";
import { checkForUpdates } from "../updater/service.js";
import {
  shouldBootstrapLocalIntegrations,
  shouldRunLocalWatcher as shouldRunLocalWatcherForState,
} from "./local-watchers.js";

const DAEMON_VERSION = getCurrentAppVersion();
const DEFAULT_AUTOSYNC_INTERVAL_MS = 60_000;
const DEFAULT_DISCORD_AUTOSYNC_INTERVAL_MS = 10 * 60_000;
const DEFAULT_SIGNAL_CATCHUP_INTERVAL_MS = 300_000;
const DEFAULT_WHATSAPP_CATCHUP_INTERVAL_MS = 300_000;
const DEFAULT_DISCORD_REALTIME_ENABLED = true;
const DEFAULT_DISCORD_DM_POLL_MS = 45_000;
const DEFAULT_SLACK_REALTIME_ENABLED = false;
const DEFAULT_INGEST_CONCURRENCY = 4;
const DEFAULT_PROJECTION_BATCH_SIZE = 250;
const DEFAULT_REALTIME_PROJECTION_ENABLED = true;
const DEFAULT_DEFERRED_PROJECTION_COALESCE_MS = 250;
const DEFAULT_PROJECTION_CONTINUE_DELAY_MS = 0;
const DEFAULT_CONTINUATION_PROJECTION_INTERVAL_MS = 60_000;
const DEFAULT_CONTINUATION_PROJECTION_BACKLOG_EVENTS = 10_000;
const NATIVE_WATCH_DEBOUNCE_MS = 1_500;
const DEFAULT_AUTOSYNC_SCHEDULER_TICK_MS = 15_000;
const DEFAULT_SYNC_CONTINUE_DELAY_MS = 15_000;
const DEFAULT_SIGNAL_RECONNECT_SYNC_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_INTERACTIVE_WINDOW_MS = 30_000;
const DEFAULT_BACKFILL_PRESSURE_WINDOW_MS = 2 * 60_000;
const DAEMON_STATUS_BUSY_TIMEOUT_MS = 100;
const MENU_BAR_STATUS_WRITE_INTERVAL_MS = 1_000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_SHUTDOWN_GRACE_MS = 30_000;
const QUEUE_DRAIN_RETRY_DELAY_MS = 1_000;
const SQLITE_BUSY_RUN_RETRY_DELAY_MS = 2_000;
const SQLITE_BUSY_RUN_RESCHEDULE_TIMEOUT_MS = 10_000;
const SIGNAL_SEND_SESSION_WAIT_MS = 3_000;
const SIGNAL_SEND_ECHO_TIMEOUT_MS = 5_000;
const WHATSAPP_SEND_SESSION_WAIT_MS = 3_000;
const daemonLogger = createLogger("daemon");
const hooksLogger = createLogger("hooks");
const nativeWatchLogger = createLogger("native-watch");
const linkedInLogger = createLogger("linkedin");
const discordLogger = createLogger("discord");
const slackLogger = createLogger("slack");
const signalLogger = createLogger("signal");
const whatsAppLogger = createLogger("whatsapp");

function getAppStatusMetadata(db: { getAppMetadata: () => unknown }): {
  hostOs: HostOS;
  version: string;
  releaseChannel: string;
  install: unknown;
} {
  return {
    hostOs:
      process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
    version: DAEMON_VERSION,
    releaseChannel: getCurrentReleaseChannel(),
    install: db.getAppMetadata(),
  };
}

function getFallbackAppStatusMetadata(): {
  hostOs: HostOS;
  version: string;
  releaseChannel: string;
  install: null;
} {
  return {
    hostOs:
      process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
    version: DAEMON_VERSION,
    releaseChannel: getCurrentReleaseChannel(),
    install: null,
  };
}

function writeMenuBarStatusSnapshot(
  db: CuedDatabase,
  options: {
    discordRealtime: DiscordRealtimeSupervisor;
    slackRealtime: SlackRealtimeSupervisor;
    linkedInRealtime: LinkedInRealtimeSupervisor;
    signalRealtime: SignalRealtimeSupervisor;
    whatsAppRealtime: WhatsAppRealtimeSupervisor;
    bootstrap: DaemonBootstrapSnapshot;
  },
): void {
  const snapshot = buildMenuBarDaemonStatusSnapshot(db, {
    app: getAppStatusMetadata(db),
    discordRealtime: options.discordRealtime,
    slackRealtime: options.slackRealtime,
    linkedInRealtime: options.linkedInRealtime,
    signalRealtime: options.signalRealtime,
    whatsAppRealtime: options.whatsAppRealtime,
    socketPath: CUED_SOCKET_PATH,
    bootstrap: options.bootstrap,
  });
  const tmpPath = `${CUED_MENU_BAR_STATUS_PATH}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  renameSync(tmpPath, CUED_MENU_BAR_STATUS_PATH);
}

function readCachedDaemonStatusSnapshot(): Record<string, unknown> | null {
  try {
    if (!existsSync(CUED_MENU_BAR_STATUS_PATH)) {
      return null;
    }
    const parsed = JSON.parse(readFileSync(CUED_MENU_BAR_STATUS_PATH, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function now(): number {
  return Date.now();
}

function getDaemonIdentity(): {
  executablePath: string;
  appPath?: string;
} {
  const appPath = process.env.CUED_APP_PATH?.trim() || undefined;
  return {
    executablePath: process.execPath,
    appPath,
  };
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

type QueueSchedulers = {
  wakeIngest: (delayMs?: number) => void;
  wakeOutbound: () => void;
  wakeProjection: (delayMs?: number) => void;
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

type SignalDesiredSession = {
  accountKey: string;
  account: string;
  cliPath: string;
  configDir: string;
};

type DiscordDesiredSession = {
  accountKey: string;
  credentials: {
    token: string;
  };
  dmPollIntervalMs?: number;
};

type SlackDesiredSession = {
  accountKey: string;
  helperPath: string;
  credentials: {
    token: string;
    cookie: string;
  };
  pollIntervalMs?: number;
  userRefreshMs?: number;
  conversationLimit?: number;
  messageLimit?: number;
};

type WhatsAppDesiredSession = {
  accountKey: string;
  helperPath: string;
  storeDir: string;
};

type LinkedInDesiredSession = {
  accountKey: string;
  cookies: ReturnType<typeof loadLinkedInSessionSecret>["cookies"];
  pageInstance: string;
  xLiTrack: string;
  serviceVersion: string | null;
  realtimeQueryMap: string;
  realtimeRecipeMap: string;
};

type PendingSignalEcho = {
  accountKey: string;
  threadId: string | null;
  text: string;
  timestamp: number;
  timeout: NodeJS.Timeout;
  outboundMessageId: string;
};

function getConfiguredAutoSyncPlatforms(): AdapterPlatform[] | null {
  const configured = process.env.CUED_AUTOSYNC_PLATFORMS?.split(",")
    .map((value) => value.trim())
    .filter(isAdapterPlatform);
  return configured && configured.length > 0 ? configured : null;
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

function getAutoSyncTargets(
  db: Pick<ReturnType<typeof openCuedDatabase>, "listEnabledSyncTargets">,
): Array<{ platform: AdapterPlatform; accountKey: string }> {
  const configured = getConfiguredAutoSyncPlatforms();

  if (configured) {
    return configured.map((platform) => ({
      platform,
      accountKey: getDefaultAccountKeyForPlatform(platform),
    }));
  }

  const enabled = db
    .listEnabledSyncTargets()
    .filter((target): target is { platform: AdapterPlatform; account_key: string } =>
      isAdapterPlatform(target.platform),
    )
    .map((target) => ({
      platform: target.platform,
      accountKey: target.account_key,
    }));
  if (enabled.length > 0) {
    return enabled;
  }

  return listAutoSyncPlatforms().map((platform) => ({
    platform,
    accountKey: getDefaultAccountKeyForPlatform(platform),
  }));
}

export function buildSyncResumeTargets(
  db: Pick<ReturnType<typeof openCuedDatabase>, "listEnabledSyncTargets" | "listCheckpointTargets">,
): Array<{ platform: AdapterPlatform; accountKey: string }> {
  return [
    ...getAutoSyncTargets(db),
    ...db
      .listCheckpointTargets()
      .filter((target): target is { platform: AdapterPlatform; account_key: string } =>
        isAdapterPlatform(target.platform),
      )
      .map((target) => ({ platform: target.platform, accountKey: target.account_key })),
  ];
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

export function shouldSkipConnectedDiscordSchedulerSync(
  targetPlatform: AdapterPlatform,
  trigger: string,
  status: DiscordRealtimeStatus | null,
): boolean {
  return targetPlatform === "discord" && trigger === "scheduler" && status?.state === "connected";
}

export function shouldProjectIngestRunInline(input: {
  platform: Platform;
  realtimeProjectionEnabled: boolean;
  firstInsertedRowId: number | null;
  lastInsertedRowId: number | null;
}): boolean {
  return (
    input.platform !== "discord" &&
    input.realtimeProjectionEnabled &&
    input.firstInsertedRowId != null &&
    input.lastInsertedRowId != null
  );
}

export function shouldThrottleIngestForInteractivity(input: {
  activeAuthSessionCount: number;
  activeIngestTargets: Iterable<{ platform: Platform | null }>;
  lastInteractiveRequestAt: number;
  interactiveWindowMs: number;
  backfillPressureUntil: number;
  nowMs: number;
}): boolean {
  if (input.activeAuthSessionCount > 0) {
    return true;
  }
  if (input.nowMs - input.lastInteractiveRequestAt <= input.interactiveWindowMs) {
    return true;
  }
  if (input.nowMs < input.backfillPressureUntil) {
    return true;
  }
  for (const target of input.activeIngestTargets) {
    if (target.platform === "imessage") {
      return true;
    }
  }
  return false;
}

export function effectiveIngestConcurrency(
  configuredConcurrency: number,
  throttled: boolean,
): number {
  return throttled ? 1 : configuredConcurrency;
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

function getSignalReconnectSyncCooldownMs(): number {
  const configured = Number(process.env.CUED_SIGNAL_RECONNECT_SYNC_COOLDOWN_MS);
  return Number.isFinite(configured) && configured >= 0
    ? Math.trunc(configured)
    : DEFAULT_SIGNAL_RECONNECT_SYNC_COOLDOWN_MS;
}

function getInteractiveWindowMs(): number {
  const configured = Number(process.env.CUED_INTERACTIVE_WINDOW_MS);
  return Number.isFinite(configured) && configured >= 0
    ? Math.trunc(configured)
    : DEFAULT_INTERACTIVE_WINDOW_MS;
}

function getBackfillPressureWindowMs(): number {
  const configured = Number(process.env.CUED_BACKFILL_PRESSURE_WINDOW_MS);
  return Number.isFinite(configured) && configured >= 0
    ? Math.trunc(configured)
    : DEFAULT_BACKFILL_PRESSURE_WINDOW_MS;
}

function getDeferredProjectionCoalesceMs(): number {
  const configured = Number(
    process.env.CUED_DEFERRED_PROJECTION_COALESCE_MS ?? DEFAULT_DEFERRED_PROJECTION_COALESCE_MS,
  );
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_DEFERRED_PROJECTION_COALESCE_MS;
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
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
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

function buildDaemonBusyStatusSnapshot(options: {
  discordRealtime: DiscordRealtimeSupervisor;
  slackRealtime: SlackRealtimeSupervisor;
  linkedInRealtime: LinkedInRealtimeSupervisor;
  signalRealtime: SignalRealtimeSupervisor;
  whatsAppRealtime: WhatsAppRealtimeSupervisor;
  socketPath: string;
  bootstrap: DaemonBootstrapSnapshot;
  dbPath: string;
  error: unknown;
}) {
  return {
    app: getFallbackAppStatusMetadata(),
    bootstrap: options.bootstrap,
    daemon: {
      pid: process.pid,
      started_at: null,
      updated_at: now(),
      status: "running",
      version: DAEMON_VERSION,
      details_json: JSON.stringify(getDaemonIdentity()),
    },
    daemonDbBusy: true,
    daemonDbBusyError:
      options.error instanceof Error ? options.error.message : String(options.error),
    overview: null,
    projection: null,
    checkpoints: [],
    recentRuns: [],
    discordRealtimeSessions: options.discordRealtime.getStatuses(),
    slackRealtimeSessions: options.slackRealtime.getStatuses(),
    linkedinRealtimeSessions: options.linkedInRealtime.getStatuses(),
    signalRealtimeSessions: options.signalRealtime.getStatuses(),
    whatsappRealtimeSessions: options.whatsAppRealtime.getStatuses(),
    integrations: [],
    socketPath: options.socketPath,
    dbPath: options.dbPath,
  };
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

function withRawEventAcquisitionMode(
  rawEvents: ProviderRawEventInput[],
  acquisitionMode: RawEventAcquisitionMode,
): ProviderRawEventInput[] {
  return rawEvents.map((rawEvent) => ({
    ...rawEvent,
    provenance: {
      ...(rawEvent.provenance ?? {}),
      acquisitionMode,
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

function getWhatsAppResyncPageBudget(): number {
  const configured = Number(process.env.CUED_WHATSAPP_RESYNC_PAGE_BUDGET ?? 10);
  return Number.isFinite(configured) && configured > 0 ? Math.trunc(configured) : 10;
}

async function safeEmitHookEvent(
  event:
    | "integration.authenticated"
    | "sync.completed"
    | "sync.failed"
    | "message.sent"
    | "message.received",
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await emitHookEvent(event, payload);
  } catch (error) {
    hooksLogger.warn(`${event} failed`, error);
  }
}

async function emitAuthenticatedHook(
  db: ReturnType<typeof openCuedDatabase>,
  platform: string,
  accountKey: string,
): Promise<void> {
  await safeEmitHookEvent("integration.authenticated", {
    integration: getIntegrationSummary(db, platform, accountKey),
  });
}

async function emitMessageSentHook(
  message: OutboundMessageRow,
  details: {
    transport: string;
    sentAt: number;
    providerMessageId?: string | null;
    conversationExternalId?: string | null;
  },
): Promise<void> {
  await safeEmitHookEvent("message.sent", {
    outboundMessage: {
      id: message.id,
      platform: message.platform,
      accountKey: message.account_key,
      target: message.target,
      threadId: message.thread_id,
      text: message.text,
      createdAt: message.created_at,
    },
    delivery: {
      transport: details.transport,
      sentAt: details.sentAt,
      providerMessageId: details.providerMessageId ?? null,
      conversationExternalId: details.conversationExternalId ?? null,
    },
  });
}

function queueNativeTriggeredSync(
  db: ReturnType<typeof openCuedDatabase>,
  platform: AdapterPlatform,
  accountKey: string,
  trigger: string,
  wakeIngest: () => void,
): void {
  const integration = db.getIntegrationState(platform, accountKey);
  if (!integration || integration.enabled !== 1 || integration.sync_capable !== 1) {
    return;
  }
  if (db.hasQueuedOrRunningRun(platform, accountKey)) {
    return;
  }

  db.queueSyncRun({
    platform,
    accountKey,
    runType: "sync",
    trigger,
    details: { source: platform, accountKey, trigger },
  });
  wakeIngest();
}

function createDebouncedSyncEnqueuer(
  db: ReturnType<typeof openCuedDatabase>,
  wakeIngest: () => void,
): (platform: AdapterPlatform, accountKey: string, trigger: string) => void {
  const timers = new Map<string, NodeJS.Timeout>();

  return (platform, accountKey, trigger) => {
    const key = `${platform}:${accountKey}`;
    const existing = timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      timers.delete(key);
      queueNativeTriggeredSync(db, platform, accountKey, trigger, wakeIngest);
    }, NATIVE_WATCH_DEBOUNCE_MS);
    timers.set(key, timer);
  };
}

function startIMessageWatcher(
  _db: ReturnType<typeof openCuedDatabase>,
  queueSync: (platform: AdapterPlatform, accountKey: string, trigger: string) => void,
): FSWatcher | ChildProcess | null {
  const nativeBinary = resolveMacOSNativeBinary(process.env.CUED_IMESSAGE_NATIVE_BINARY);
  if (nativeBinary) {
    const child = spawn(nativeBinary, ["imessage", "watch", "--db-path", DEFAULT_CHAT_DB_PATH], {
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

    child.on("exit", (code) => {
      if (code && code !== 0) {
        nativeWatchLogger.warn(`imessage watcher exited`, { code });
      }
    });

    return child;
  }

  try {
    const targetDir = dirname(DEFAULT_CHAT_DB_PATH);
    const watchedNames = new Set([
      basename(DEFAULT_CHAT_DB_PATH),
      `${basename(DEFAULT_CHAT_DB_PATH)}-wal`,
      `${basename(DEFAULT_CHAT_DB_PATH)}-shm`,
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

    child.on("exit", (code) => {
      if (code && code !== 0) {
        nativeWatchLogger.warn("callhistory watcher exited", { code });
      }
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

  child.on("exit", (code) => {
    if (code && code !== 0) {
      nativeWatchLogger.warn("contacts watcher exited", { code });
    }
  });

  return child;
}

function isInboundMessageEvent(rawEvent: Record<string, unknown>): boolean {
  return (
    rawEvent.entityKind === "message" &&
    rawEvent.eventKind === "created" &&
    typeof rawEvent.payload === "object" &&
    rawEvent.payload !== null &&
    typeof (rawEvent.payload as Record<string, unknown>).senderSourceKey === "string" &&
    ((rawEvent.payload as Record<string, unknown>).senderSourceKey as string).length > 0
  );
}

function resolveSignalTarget(message: OutboundMessageRow): {
  recipient?: string;
  groupId?: string;
} {
  const threadId = message.thread_id ?? "";
  const target = message.target;
  if (threadId.startsWith("group:")) {
    return { groupId: threadId.slice("group:".length) };
  }
  if (target.startsWith("group:")) {
    return { groupId: target.slice("group:".length) };
  }
  return { recipient: target };
}

function isRetryableSignalSendError(message: string): boolean {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("invalid") ||
    normalized.includes("unregistered") ||
    normalized.includes("not found") ||
    normalized.includes("malformed")
  ) {
    return false;
  }
  return true;
}

async function sendSignalOutboundMessage(
  message: OutboundMessageRow,
  signalRealtime: SignalRealtimeSupervisor,
): Promise<{ transport: "session" | "fallback"; timestamp: number }> {
  const target = resolveSignalTarget(message);
  const session = signalRealtime.getSession(message.account_key);
  if (session?.isConnected()) {
    const result = await session.sendMessage(message.text, target);
    return {
      transport: "session",
      timestamp: result.timestamp,
    };
  }

  const waitedSession = await signalRealtime.waitForConnected(
    message.account_key,
    SIGNAL_SEND_SESSION_WAIT_MS,
  );
  if (waitedSession?.isConnected()) {
    const result = await waitedSession.sendMessage(message.text, target);
    return {
      transport: "session",
      timestamp: result.timestamp,
    };
  }

  const inspected = await inspectSignalCli();
  if (!inspected.cliPath) {
    throw new Error("Bundled Signal helper was not found");
  }
  if (!isSignalCliVersionSupported(inspected.version)) {
    throw new Error(
      `Bundled Signal helper is too old or invalid (${inspected.version?.raw ?? "unknown"})`,
    );
  }

  const configDir = getSignalConfigDir(message.account_key);
  const account = readSignalLinkedAccount(configDir);
  if (!account) {
    throw new Error(`Signal account is not linked for '${message.account_key}'`);
  }

  const client = new SignalCliClient({
    account,
    cliPath: inspected.cliPath,
    configDir,
  });
  const result = await client.sendMessage(message.text, target);
  return {
    transport: "fallback",
    timestamp: result.timestamp,
  };
}

async function collectDesiredSignalSessions(db: ReturnType<typeof openCuedDatabase>): Promise<{
  desired: SignalDesiredSession[];
  degraded: Array<Omit<SignalRealtimeStatus, "platform">>;
}> {
  const integrations = db
    .listIntegrationStates()
    .filter(
      (row) =>
        row.platform === "signal" &&
        row.enabled === 1 &&
        row.auth_state === "authenticated" &&
        !db.hasQueuedOrRunningRun("signal", row.account_key),
    );
  if (integrations.length === 0) {
    return {
      desired: [],
      degraded: [],
    };
  }

  const inspected = await inspectSignalCli();
  const baseStatus = (integration: {
    account_key: string;
  }): Omit<SignalRealtimeStatus, "platform"> => ({
    accountKey: integration.account_key,
    account: "",
    cliPath: inspected.cliPath ?? "",
    configDir: getSignalConfigDir(integration.account_key),
    state: "degraded",
    connectedAt: null,
    lastNotificationAt: null,
    lastReconnectAt: null,
    reconnectAttempts: 0,
    lastSessionError: null,
  });

  if (!inspected.cliPath) {
    return {
      desired: [],
      degraded: integrations.map((integration) => ({
        ...baseStatus(integration),
        lastSessionError: "Bundled Signal helper was not found",
      })),
    };
  }

  if (!isSignalCliVersionSupported(inspected.version)) {
    return {
      desired: [],
      degraded: integrations.map((integration) => ({
        ...baseStatus(integration),
        lastSessionError: `Bundled Signal helper is too old or invalid (${inspected.version?.raw ?? "unknown"})`,
      })),
    };
  }

  const desired: SignalDesiredSession[] = [];
  const degraded: Array<Omit<SignalRealtimeStatus, "platform">> = [];
  for (const integration of integrations) {
    const configDir = getSignalConfigDir(integration.account_key);
    const account = readSignalLinkedAccount(configDir);
    if (!account) {
      degraded.push({
        ...baseStatus(integration),
        cliPath: inspected.cliPath,
        configDir,
        lastSessionError: "Signal account is not linked in Cued's managed config",
      });
      continue;
    }

    desired.push({
      accountKey: integration.account_key,
      account,
      cliPath: inspected.cliPath,
      configDir,
    });
  }

  return { desired, degraded };
}

async function collectDesiredDiscordSessions(db: ReturnType<typeof openCuedDatabase>): Promise<{
  desired: DiscordDesiredSession[];
  degraded: Array<Omit<DiscordRealtimeStatus, "platform">>;
}> {
  const integrations = db
    .listIntegrationStates()
    .filter(
      (row) =>
        row.platform === "discord" && row.enabled === 1 && row.auth_state === "authenticated",
    );
  if (integrations.length === 0 || !getDiscordRealtimeEnabled()) {
    return {
      desired: [],
      degraded: [],
    };
  }

  const desired: DiscordDesiredSession[] = [];
  const degraded: Array<Omit<DiscordRealtimeStatus, "platform">> = [];
  for (const integration of integrations) {
    try {
      const secret = loadIntegrationSecret("discord", integration.account_key).secret;
      if (typeof secret.token !== "string" || secret.token.trim().length === 0) {
        degraded.push({
          accountKey: integration.account_key,
          state: "degraded",
          userId: null,
          username: null,
          connectedAt: null,
          lastEventAt: null,
          lastReconnectAt: null,
          reconnectAttempts: 0,
          lastSessionError: "Discord credentials are missing the stored token",
        });
        continue;
      }

      desired.push({
        accountKey: integration.account_key,
        credentials: {
          token: secret.token,
        },
        dmPollIntervalMs: Number.isFinite(Number(process.env.CUED_DISCORD_DM_POLL_MS))
          ? Number(process.env.CUED_DISCORD_DM_POLL_MS)
          : DEFAULT_DISCORD_DM_POLL_MS,
      });
    } catch (error) {
      degraded.push({
        accountKey: integration.account_key,
        state: "degraded",
        userId: null,
        username: null,
        connectedAt: null,
        lastEventAt: null,
        lastReconnectAt: null,
        reconnectAttempts: 0,
        lastSessionError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { desired, degraded };
}

function blockDiscordIntegration(
  db: ReturnType<typeof openCuedDatabase>,
  accountKey: string,
  errorSummary: string,
): void {
  const integration = db.getIntegrationState("discord", accountKey);
  if (!integration) {
    return;
  }

  const metadata =
    safeParseJsonRecord(integration.metadata_json, "integration_states.metadata_json") ?? {};
  db.upsertIntegrationState({
    platform: "discord",
    accountKey,
    displayName: integration.display_name,
    authState: "blocked",
    enabled: integration.enabled === 1,
    connectionKind: integration.connection_kind,
    syncCapable: false,
    launchStrategy: integration.launch_strategy,
    launchTarget: integration.launch_target,
    importedFrom: integration.imported_from,
    artifactPaths: safeParseJsonStringArray(
      integration.artifact_paths_json,
      "integration_states.artifact_paths_json",
    ),
    metadata: {
      ...metadata,
      lastAuthError: errorSummary,
      blockedAt: now(),
      blockedReason: "discord_auth_invalidated",
    },
  });
  db.recordCheckpointError("discord", accountKey, errorSummary);
}

async function collectDesiredSlackSessions(db: ReturnType<typeof openCuedDatabase>): Promise<{
  desired: SlackDesiredSession[];
  degraded: Array<Omit<SlackRealtimeStatus, "platform">>;
}> {
  const integrations = db
    .listIntegrationStates()
    .filter(
      (row) => row.platform === "slack" && row.enabled === 1 && row.auth_state === "authenticated",
    );
  if (integrations.length === 0 || !getSlackRealtimeEnabled()) {
    return {
      desired: [],
      degraded: [],
    };
  }

  const inspected = inspectSlackHelper();
  const baseStatus = (integration: {
    account_key: string;
  }): Omit<SlackRealtimeStatus, "platform"> => ({
    accountKey: integration.account_key,
    helperPath: inspected.helperPath ?? "",
    state: "degraded",
    teamId: null,
    userId: null,
    transport: null,
    connectedAt: null,
    lastEventAt: null,
    lastReconnectAt: null,
    reconnectAttempts: 0,
    lastSessionError: null,
  });

  if (!inspected.helperPath) {
    return {
      desired: [],
      degraded: integrations.map((integration) => ({
        ...baseStatus(integration),
        lastSessionError: "Slack helper was not found",
      })),
    };
  }

  if (!inspected.versionSupported) {
    return {
      desired: [],
      degraded: integrations.map((integration) => ({
        ...baseStatus(integration),
        lastSessionError: `Slack helper is too old or invalid (${inspected.version ?? "unknown"})`,
      })),
    };
  }

  const desired: SlackDesiredSession[] = [];
  const degraded: Array<Omit<SlackRealtimeStatus, "platform">> = [];
  for (const integration of integrations) {
    try {
      const secret = loadIntegrationSecret("slack", integration.account_key).secret;
      if (typeof secret.token !== "string" || typeof secret.cookie !== "string") {
        degraded.push({
          ...baseStatus(integration),
          helperPath: inspected.helperPath,
          lastSessionError: "Slack credentials are missing token or cookie",
        });
        continue;
      }

      desired.push({
        accountKey: integration.account_key,
        helperPath: inspected.helperPath,
        credentials: {
          token: secret.token,
          cookie: secret.cookie,
        },
        pollIntervalMs: Number.isFinite(Number(process.env.CUED_SLACK_REALTIME_POLL_MS))
          ? Number(process.env.CUED_SLACK_REALTIME_POLL_MS)
          : undefined,
        userRefreshMs: Number.isFinite(Number(process.env.CUED_SLACK_REALTIME_USER_REFRESH_MS))
          ? Number(process.env.CUED_SLACK_REALTIME_USER_REFRESH_MS)
          : undefined,
        conversationLimit: Number.isFinite(
          Number(process.env.CUED_SLACK_REALTIME_CONVERSATION_LIMIT),
        )
          ? Number(process.env.CUED_SLACK_REALTIME_CONVERSATION_LIMIT)
          : undefined,
        messageLimit: Number.isFinite(Number(process.env.CUED_SLACK_REALTIME_MESSAGE_LIMIT))
          ? Number(process.env.CUED_SLACK_REALTIME_MESSAGE_LIMIT)
          : undefined,
      });
    } catch (error) {
      degraded.push({
        ...baseStatus(integration),
        helperPath: inspected.helperPath,
        lastSessionError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { desired, degraded };
}

async function collectDesiredWhatsAppSessions(db: ReturnType<typeof openCuedDatabase>): Promise<{
  desired: WhatsAppDesiredSession[];
  degraded: Array<Omit<WhatsAppRealtimeStatus, "platform">>;
}> {
  const integrations = db
    .listIntegrationStates()
    .filter(
      (row) =>
        row.platform === "whatsapp" && row.enabled === 1 && row.auth_state === "authenticated",
    );
  if (integrations.length === 0) {
    return {
      desired: [],
      degraded: [],
    };
  }

  const inspected = inspectWhatsAppHelper();
  const baseStatus = (integration: {
    account_key: string;
  }): Omit<WhatsAppRealtimeStatus, "platform"> => ({
    accountKey: integration.account_key,
    helperPath: inspected.helperPath ?? "",
    storeDir: getWhatsAppStoreDir(integration.account_key),
    state: "degraded",
    accountJid: null,
    connectedAt: null,
    lastEventAt: null,
    lastHistorySyncAt: null,
    lastReconnectAt: null,
    reconnectAttempts: 0,
    lastSessionError: null,
  });

  if (!inspected.helperPath) {
    return {
      desired: [],
      degraded: integrations.map((integration) => ({
        ...baseStatus(integration),
        lastSessionError: "WhatsApp helper was not found",
      })),
    };
  }

  const desired: WhatsAppDesiredSession[] = [];
  const degraded: Array<Omit<WhatsAppRealtimeStatus, "platform">> = [];
  for (const integration of integrations) {
    const storeDir = getWhatsAppStoreDir(integration.account_key);
    try {
      const status = await readWhatsAppHelperStatus(storeDir);
      if (!status.authenticated || !status.accountJid) {
        degraded.push({
          ...baseStatus(integration),
          helperPath: inspected.helperPath,
          storeDir,
          lastSessionError: "WhatsApp account is not linked in Cued's managed store",
        });
        continue;
      }
    } catch (error) {
      degraded.push({
        ...baseStatus(integration),
        helperPath: inspected.helperPath,
        storeDir,
        lastSessionError: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    desired.push({
      accountKey: integration.account_key,
      helperPath: inspected.helperPath,
      storeDir,
    });
  }

  return { desired, degraded };
}

function readIntegrationAuthResult(metadataJson: string | null): Record<string, unknown> | null {
  if (!metadataJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(metadataJson) as { authResult?: unknown };
    return typeof parsed.authResult === "object" && parsed.authResult !== null
      ? (parsed.authResult as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function collectDesiredLinkedInSessions(db: ReturnType<typeof openCuedDatabase>): Promise<{
  desired: LinkedInDesiredSession[];
  degraded: Array<Omit<LinkedInRealtimeStatus, "platform">>;
}> {
  const integrations = db
    .listIntegrationStates()
    .filter(
      (row) =>
        row.platform === "linkedin" && row.enabled === 1 && row.auth_state === "authenticated",
    );
  if (integrations.length === 0) {
    return {
      desired: [],
      degraded: [],
    };
  }

  const desired: LinkedInDesiredSession[] = [];
  const degraded: Array<Omit<LinkedInRealtimeStatus, "platform">> = [];
  for (const integration of integrations) {
    const authResult = readIntegrationAuthResult(integration.metadata_json);
    if (authResult?.realtimeReady !== true) {
      degraded.push({
        accountKey: integration.account_key,
        state: "degraded",
        connectedAt: null,
        lastEventAt: null,
        lastReconnectAt: null,
        reconnectAttempts: 0,
        lastSessionError: "LinkedIn realtime headers were not captured during auth",
      });
      continue;
    }

    try {
      const session = loadLinkedInSessionSecret(integration.account_key);
      if (
        !session.cookies.length ||
        !session.pageInstance ||
        !session.xLiTrack ||
        !session.realtimeQueryMap ||
        !session.realtimeRecipeMap
      ) {
        degraded.push({
          accountKey: integration.account_key,
          state: "degraded",
          connectedAt: null,
          lastEventAt: null,
          lastReconnectAt: null,
          reconnectAttempts: 0,
          lastSessionError: "LinkedIn realtime session data is incomplete",
        });
        continue;
      }

      desired.push({
        accountKey: integration.account_key,
        cookies: session.cookies,
        pageInstance: session.pageInstance,
        xLiTrack: session.xLiTrack,
        serviceVersion: session.serviceVersion,
        realtimeQueryMap: session.realtimeQueryMap,
        realtimeRecipeMap: session.realtimeRecipeMap,
      });
    } catch (error) {
      degraded.push({
        accountKey: integration.account_key,
        state: "degraded",
        connectedAt: null,
        lastEventAt: null,
        lastReconnectAt: null,
        reconnectAttempts: 0,
        lastSessionError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { desired, degraded };
}
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
  const startedAt = now();
  const ingestConcurrency = getIngestConcurrency();
  const projectionBatchSize = getProjectionBatchSize();
  const realtimeProjectionEnabled = getRealtimeProjectionEnabled();
  const realtimeProjectionBatchSize = getRealtimeProjectionBatchSize();
  const deferredProjectionCoalesceMs = getDeferredProjectionCoalesceMs();
  const projectionContinueDelayMs = getProjectionContinueDelayMs();
  const continuationProjectionIntervalMs = getContinuationProjectionIntervalMs();
  const continuationProjectionBacklogEvents = getContinuationProjectionBacklogEvents();
  const syncContinueDelayMs = getSyncContinueDelayMs();
  const signalReconnectSyncCooldownMs = getSignalReconnectSyncCooldownMs();
  const interactiveWindowMs = getInteractiveWindowMs();
  const backfillPressureWindowMs = getBackfillPressureWindowMs();
  const configuredRealtimePlatforms = getConfiguredRealtimePlatforms();
  const shouldRunRealtimePlatform = (platform: AdapterPlatform): boolean =>
    configuredRealtimePlatforms == null || configuredRealtimePlatforms.has(platform);
  const activeAuthSessions = new Map<
    string,
    { child: ChildProcess; platform: Platform; accountKey: string }
  >();
  const activeIngestRuns = new Map<string, Promise<void>>();
  const activeIngestRunTargets = new Map<
    string,
    { platform: Platform | null; accountKey: string | null }
  >();
  let lastInteractiveRequestAt = 0;
  let backfillPressureUntil = 0;
  const markInteractive = () => {
    lastInteractiveRequestAt = now();
  };
  const isInteractiveActive = () =>
    activeAuthSessions.size > 0 || now() - lastInteractiveRequestAt <= interactiveWindowMs;
  const isBackfillPressureActive = () =>
    now() < backfillPressureUntil ||
    [...activeIngestRunTargets.values()].some((target) => target.platform === "imessage");
  const isIngestThrottled = () =>
    shouldThrottleIngestForInteractivity({
      activeAuthSessionCount: activeAuthSessions.size,
      activeIngestTargets: activeIngestRunTargets.values(),
      lastInteractiveRequestAt,
      interactiveWindowMs,
      backfillPressureUntil,
      nowMs: now(),
    });
  const currentIngestConcurrency = () =>
    effectiveIngestConcurrency(ingestConcurrency, isIngestThrottled());
  let activeOutboundSend: Promise<void> | null = null;
  let isProcessingProjection = false;
  let ingestDrainScheduled = false;
  let outboundDrainScheduled = false;
  let projectionDrainScheduled = false;
  let ingestDrainTimer: NodeJS.Timeout | null = null;
  let projectionDrainTimer: NodeJS.Timeout | null = null;
  let ingestDrainDueAt: number | null = null;
  let projectionDrainDueAt: number | null = null;
  const lastAutoSyncQueuedAt = new Map<string, number>();
  const lastSignalReconnectSyncQueuedAt = new Map<string, number>();
  const lastContinuationProjectionQueuedAt = new Map<string, number>();
  const pendingSignalSendEchoes = new Map<string, PendingSignalEcho[]>();
  const projectionMessageHooks = new ProjectionMessageHookBarrier();
  const suppressNextSignalReconnectSync = new Set<string>();
  const nativeWatchers = new Map<
    "contacts" | "imessage" | "callhistory",
    FSWatcher | ChildProcess
  >();
  let discordRealtimeReconcilePromise: Promise<void> | null = null;
  let discordRealtimeReconcileQueued = false;
  let linkedInRealtimeReconcilePromise: Promise<void> | null = null;
  let linkedInRealtimeReconcileQueued = false;
  let slackRealtimeReconcilePromise: Promise<void> | null = null;
  let slackRealtimeReconcileQueued = false;
  let signalRealtimeReconcilePromise: Promise<void> | null = null;
  let signalRealtimeReconcileQueued = false;
  let whatsAppRealtimeReconcilePromise: Promise<void> | null = null;
  let whatsAppRealtimeReconcileQueued = false;
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

  const clearSignalSendEcho = (
    accountKey: string,
    matcher: (echo: PendingSignalEcho) => boolean,
  ) => {
    const echoes = pendingSignalSendEchoes.get(accountKey);
    if (!echoes || echoes.length === 0) {
      return;
    }

    const remaining: PendingSignalEcho[] = [];
    for (const echo of echoes) {
      if (matcher(echo)) {
        clearTimeout(echo.timeout);
        continue;
      }
      remaining.push(echo);
    }

    if (remaining.length === 0) {
      pendingSignalSendEchoes.delete(accountKey);
      return;
    }
    pendingSignalSendEchoes.set(accountKey, remaining);
  };

  const queueMessageReceivedHooks = (
    range: { startRowId: number; endRowId: number } | null,
    inboundMessages: ProjectionMessageHookPayload[],
  ) => {
    if (!range || inboundMessages.length === 0) {
      return;
    }

    const batches = buildProjectionMessageHookBatches(range, inboundMessages, projectionBatchSize);
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

  const scheduleSignalSendEchoCatchup = (message: OutboundMessageRow, timestamp: number) => {
    const threadId = message.thread_id ?? null;
    const pending: PendingSignalEcho = {
      accountKey: message.account_key,
      threadId,
      text: message.text,
      timestamp,
      outboundMessageId: message.id,
      timeout: setTimeout(() => {
        clearSignalSendEcho(
          message.account_key,
          (candidate) => candidate.outboundMessageId === message.id,
        );
        if (!db.hasQueuedOrRunningRun(message.platform, message.account_key)) {
          db.queueSyncRun({
            platform: message.platform,
            accountKey: message.account_key,
            runType: "sync",
            trigger: "signal_send_echo_timeout",
            details: {
              source: message.platform,
              accountKey: message.account_key,
              trigger: "signal_send_echo_timeout",
              outboundMessageId: message.id,
            },
          });
          schedulers.wakeIngest();
        }
      }, SIGNAL_SEND_ECHO_TIMEOUT_MS),
    };

    const existing = pendingSignalSendEchoes.get(message.account_key) ?? [];
    existing.push(pending);
    pendingSignalSendEchoes.set(message.account_key, existing);
  };

  const updateSlackCheckpointFromRealtime = (accountKey: string) => {
    const checkpoint = db.getCheckpoint("slack", accountKey);
    const projection = db.getProjectionBacklog();
    const sourceCursor = safeParseJsonRecord(
      checkpoint?.source_cursor_json ?? null,
      "sync_checkpoints.source_cursor_json",
    );
    db.upsertCheckpoint({
      platform: "slack",
      accountKey,
      syncMode: checkpoint?.sync_mode ?? "incremental",
      sourceCursor,
      rawIngestWatermark: projection.max_raw_event_rowid,
      lastSuccessAt: now(),
      lastErrorSummary: null,
    });
  };

  const ingestSlackRealtimeRawEvents = async (
    accountKey: string,
    rawEvents: ReturnType<typeof buildSlackMessageEvents>,
    trigger: string,
  ): Promise<void> => {
    try {
      if (rawEvents.length === 0) {
        return;
      }

      db.upsertSourceAccounts([
        {
          platform: "slack",
          accountKey,
          displayName: "Slack",
        },
      ]);
      const insertResult = db.insertRawEvents(withRawEventAcquisitionMode(rawEvents, "realtime"));
      if (
        realtimeProjectionEnabled &&
        insertResult.firstInsertedRowId != null &&
        insertResult.lastInsertedRowId != null
      ) {
        projectRealtimeRange(db, {
          startRowId: insertResult.firstInsertedRowId,
          endRowId: insertResult.lastInsertedRowId,
          batchSize: realtimeProjectionBatchSize,
        });
      }
      const projection = db.getProjectionBacklog();
      if (projection.pending_raw_events > 0) {
        queueProjectionRun(trigger, undefined, { delayMs: deferredProjectionCoalesceMs });
      }
      if (insertResult.insertedCount > 0) {
        updateSlackCheckpointFromRealtime(accountKey);
      }

      const inboundMessages = collectInboundMessageHookPayloads(
        trigger,
        insertResult.insertedRows,
        isInboundMessageEvent,
      );
      queueMessageReceivedHooks(
        insertResult.firstInsertedRowId != null && insertResult.lastInsertedRowId != null
          ? {
              startRowId: insertResult.firstInsertedRowId,
              endRowId: insertResult.lastInsertedRowId,
            }
          : null,
        inboundMessages,
      );
      if (
        projection.pending_raw_events === 0 &&
        insertResult.firstInsertedRowId != null &&
        insertResult.lastInsertedRowId != null
      ) {
        await releaseMessageReceivedHooksForRange({
          startRowId: insertResult.firstInsertedRowId,
          endRowId: insertResult.lastInsertedRowId,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      slackLogger.warn("realtime ingest failed", { accountKey, error: message });
      if (isSqliteBusyError(error)) {
        queueNativeTriggeredSync(
          db,
          "slack",
          accountKey,
          "slack_realtime_busy_fallback",
          schedulers.wakeIngest,
        );
      }
    }
  };

  const updateDiscordCheckpointFromRealtime = (accountKey: string) => {
    const checkpoint = db.getCheckpoint("discord", accountKey);
    const projection = db.getProjectionBacklog();
    const sourceCursor = safeParseJsonRecord(
      checkpoint?.source_cursor_json ?? null,
      "sync_checkpoints.source_cursor_json",
    );
    db.upsertCheckpoint({
      platform: "discord",
      accountKey,
      syncMode: checkpoint?.sync_mode ?? "incremental",
      sourceCursor,
      rawIngestWatermark: projection.max_raw_event_rowid,
      lastSuccessAt: now(),
      lastErrorSummary: null,
    });
  };

  const ingestDiscordRealtimeRawEvents = async (
    accountKey: string,
    rawEvents: ProviderRawEventInput[],
    trigger: string,
    sourceAccountDisplayName = "Discord",
  ): Promise<void> => {
    try {
      if (rawEvents.length === 0) {
        return;
      }

      db.upsertSourceAccounts([
        {
          platform: "discord",
          accountKey,
          displayName: sourceAccountDisplayName,
        },
      ]);
      const insertResult = db.insertRawEvents(withRawEventAcquisitionMode(rawEvents, "realtime"));
      if (
        realtimeProjectionEnabled &&
        insertResult.firstInsertedRowId != null &&
        insertResult.lastInsertedRowId != null
      ) {
        projectRealtimeRange(db, {
          startRowId: insertResult.firstInsertedRowId,
          endRowId: insertResult.lastInsertedRowId,
          batchSize: realtimeProjectionBatchSize,
        });
      }
      const projection = db.getProjectionBacklog();
      if (projection.pending_raw_events > 0) {
        queueProjectionRun(trigger, undefined, { delayMs: deferredProjectionCoalesceMs });
      }
      if (insertResult.insertedCount > 0) {
        updateDiscordCheckpointFromRealtime(accountKey);
      }

      const inboundMessages = collectInboundMessageHookPayloads(
        trigger,
        insertResult.insertedRows,
        isInboundMessageEvent,
      );
      queueMessageReceivedHooks(
        insertResult.firstInsertedRowId != null && insertResult.lastInsertedRowId != null
          ? {
              startRowId: insertResult.firstInsertedRowId,
              endRowId: insertResult.lastInsertedRowId,
            }
          : null,
        inboundMessages,
      );
      if (
        projection.pending_raw_events === 0 &&
        insertResult.firstInsertedRowId != null &&
        insertResult.lastInsertedRowId != null
      ) {
        await releaseMessageReceivedHooksForRange({
          startRowId: insertResult.firstInsertedRowId,
          endRowId: insertResult.lastInsertedRowId,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      discordLogger.warn("realtime ingest failed", { accountKey, error: message });
      if (isSqliteBusyError(error)) {
        queueNativeTriggeredSync(
          db,
          "discord",
          accountKey,
          "discord_realtime_busy_fallback",
          schedulers.wakeIngest,
        );
      }
    }
  };

  const handleSlackRealtimeEvent = async (
    accountKey: string,
    event: SlackRealtimeEventEnvelope,
  ): Promise<void> => {
    const observedAt = now();
    switch (event.event) {
      case "contact_upsert":
        await ingestSlackRealtimeRawEvents(
          accountKey,
          buildSlackContactEvents(event.data.teamId, accountKey, observedAt, [event.data.user]),
          `slack_realtime:${accountKey}`,
        );
        return;
      case "conversation_upsert":
        await ingestSlackRealtimeRawEvents(
          accountKey,
          [
            buildSlackConversationEvent({
              teamId: event.data.teamId,
              accountKey,
              conversation: event.data.conversation,
              observedAt,
              memberIds: event.data.memberIds,
              selfUserId: event.data.selfUserId,
              displayName: event.data.displayName,
            }),
          ],
          `slack_realtime:${accountKey}`,
        );
        if (event.data.isNew) {
          queueNativeTriggeredSync(
            db,
            "slack",
            accountKey,
            "slack_realtime_new_conversation",
            schedulers.wakeIngest,
          );
        }
        return;
      case "message_upsert":
        await ingestSlackRealtimeRawEvents(
          accountKey,
          buildSlackMessageEvents({
            teamId: event.data.teamId,
            accountKey,
            conversationId: event.data.conversationId,
            selfUserId: event.data.selfUserId,
            observedAt,
            messages: [event.data.message],
          }),
          `slack_realtime:${accountKey}`,
        );
        return;
      default:
        return;
    }
  };

  const handleDiscordRealtimeEvent = async (
    accountKey: string,
    event: DiscordRealtimeEventEnvelope,
  ): Promise<void> => {
    const observedAt = now();
    switch (event.event) {
      case "contact_upsert":
        await ingestDiscordRealtimeRawEvents(
          accountKey,
          [
            buildDiscordContactEvent({
              accountKey,
              observedAt,
              user: event.data.user,
              displayName: event.data.displayName,
            }),
          ],
          `discord_realtime:${accountKey}`,
        );
        return;
      case "conversation_upsert":
        await ingestDiscordRealtimeRawEvents(
          accountKey,
          [
            buildDiscordConversationEvent({
              accountKey,
              observedAt,
              channel: event.data.channel,
              currentUser: event.data.currentUser,
            }),
          ],
          `discord_realtime:${accountKey}`,
          event.data.currentUser.global_name?.trim() || event.data.currentUser.username,
        );
        if (event.data.isNew) {
          queueNativeTriggeredSync(
            db,
            "discord",
            accountKey,
            "discord_realtime_new_conversation",
            schedulers.wakeIngest,
          );
        }
        return;
      case "message_upsert":
        await ingestDiscordRealtimeRawEvents(
          accountKey,
          [
            buildDiscordMessageEvent({
              accountKey,
              observedAt,
              channel: event.data.channel,
              message: event.data.message,
              currentUserId: event.data.currentUserId,
            }),
          ],
          `discord_realtime:${accountKey}`,
        );
        return;
      default:
        return;
    }
  };

  const updateLinkedInCheckpointFromRealtime = (accountKey: string) => {
    const checkpoint = db.getCheckpoint("linkedin", accountKey);
    const projection = db.getProjectionBacklog();
    const sourceCursor = safeParseJsonRecord(
      checkpoint?.source_cursor_json ?? null,
      "sync_checkpoints.source_cursor_json",
    );
    db.upsertCheckpoint({
      platform: "linkedin",
      accountKey,
      syncMode: checkpoint?.sync_mode ?? "incremental",
      sourceCursor,
      rawIngestWatermark: projection.max_raw_event_rowid,
      lastSuccessAt: now(),
      lastErrorSummary: null,
    });
  };

  const ingestLinkedInRealtimeEnvelope = async (
    accountKey: string,
    envelope: Parameters<typeof buildLinkedInRawEventsFromRealtimeEnvelope>[0]["envelope"],
    userEntityUrn: string,
  ): Promise<void> => {
    try {
      const rawEvents = withRawEventAcquisitionMode(
        buildLinkedInRawEventsFromRealtimeEnvelope({
          accountKey,
          userEntityUrn,
          envelope,
        }),
        "realtime",
      );
      if (rawEvents.length === 0) {
        return;
      }

      db.upsertSourceAccounts([
        {
          platform: "linkedin",
          accountKey,
          displayName: "LinkedIn",
        },
      ]);
      const insertResult = db.insertRawEvents(rawEvents);
      if (
        realtimeProjectionEnabled &&
        insertResult.firstInsertedRowId != null &&
        insertResult.lastInsertedRowId != null
      ) {
        projectRealtimeRange(db, {
          startRowId: insertResult.firstInsertedRowId,
          endRowId: insertResult.lastInsertedRowId,
          batchSize: realtimeProjectionBatchSize,
        });
      }
      const projection = db.getProjectionBacklog();
      if (projection.pending_raw_events > 0) {
        queueProjectionRun(`linkedin_realtime:${accountKey}`, undefined, {
          delayMs: deferredProjectionCoalesceMs,
        });
      }
      if (insertResult.insertedCount > 0) {
        updateLinkedInCheckpointFromRealtime(accountKey);
      }

      const inboundMessages = collectInboundMessageHookPayloads(
        `linkedin_realtime:${accountKey}`,
        insertResult.insertedRows,
        isInboundMessageEvent,
      );
      queueMessageReceivedHooks(
        insertResult.firstInsertedRowId != null && insertResult.lastInsertedRowId != null
          ? {
              startRowId: insertResult.firstInsertedRowId,
              endRowId: insertResult.lastInsertedRowId,
            }
          : null,
        inboundMessages,
      );
      if (
        projection.pending_raw_events === 0 &&
        insertResult.firstInsertedRowId != null &&
        insertResult.lastInsertedRowId != null
      ) {
        await releaseMessageReceivedHooksForRange({
          startRowId: insertResult.firstInsertedRowId,
          endRowId: insertResult.lastInsertedRowId,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      linkedInLogger.warn("realtime ingest failed", { accountKey, error: message });
      if (isSqliteBusyError(error)) {
        queueNativeTriggeredSync(
          db,
          "linkedin",
          accountKey,
          "linkedin_realtime_busy_fallback",
          schedulers.wakeIngest,
        );
      }
    }
  };

  const updateSignalCheckpointFromRealtime = (accountKey: string) => {
    const checkpoint = db.getCheckpoint("signal", accountKey);
    const projection = db.getProjectionBacklog();
    const sourceCursor = safeParseJsonRecord(
      checkpoint?.source_cursor_json ?? null,
      "sync_checkpoints.source_cursor_json",
    );
    db.upsertCheckpoint({
      platform: "signal",
      accountKey,
      syncMode: checkpoint?.sync_mode ?? "incremental",
      sourceCursor,
      rawIngestWatermark: projection.max_raw_event_rowid,
      lastSuccessAt: now(),
      lastErrorSummary: null,
    });
  };

  const runSignalSyncExclusively = async <T>(
    accountKey: string,
    task: () => Promise<T>,
  ): Promise<T> => {
    const activeSession = signalRealtime.getSession(accountKey);
    if (!activeSession) {
      return await task();
    }

    suppressNextSignalReconnectSync.add(accountKey);
    await signalRealtime.stopSession(accountKey);

    try {
      return await task();
    } finally {
      requestSignalRealtimeReconcile();
    }
  };

  const ingestSignalRealtimeMessages = async (
    accountKey: string,
    messages: Parameters<typeof buildSignalRawEventsFromMessages>[0]["messages"],
  ): Promise<void> => {
    try {
      const rawEvents = withRawEventAcquisitionMode(
        buildSignalRawEventsFromMessages({
          accountKey,
          messages,
        }),
        "realtime",
      );
      if (rawEvents.length === 0) {
        return;
      }

      db.upsertSourceAccounts([
        {
          platform: "signal",
          accountKey,
          displayName: "Signal",
        },
      ]);
      const insertResult = db.insertRawEvents(rawEvents);
      if (
        realtimeProjectionEnabled &&
        insertResult.firstInsertedRowId != null &&
        insertResult.lastInsertedRowId != null
      ) {
        projectRealtimeRange(db, {
          startRowId: insertResult.firstInsertedRowId,
          endRowId: insertResult.lastInsertedRowId,
          batchSize: realtimeProjectionBatchSize,
        });
      }
      const projection = db.getProjectionBacklog();
      if (projection.pending_raw_events > 0) {
        queueProjectionRun(`signal_realtime:${accountKey}`, undefined, {
          delayMs: deferredProjectionCoalesceMs,
        });
      }
      if (insertResult.insertedCount > 0) {
        updateSignalCheckpointFromRealtime(accountKey);
      }

      for (const message of messages) {
        if (message.isFromMe) {
          const normalizedThreadId = message.threadId;
          const normalizedText = message.text.trim();
          clearSignalSendEcho(accountKey, (echo) => {
            const sameThread = !echo.threadId || echo.threadId === normalizedThreadId;
            const sameText = echo.text.trim() === normalizedText;
            const nearTimestamp = Math.abs(echo.timestamp - message.sentAt) < 30_000;
            return sameThread && sameText && nearTimestamp;
          });
        }
      }

      const inboundMessages = collectInboundMessageHookPayloads(
        `signal_realtime:${accountKey}`,
        insertResult.insertedRows,
        isInboundMessageEvent,
      );
      queueMessageReceivedHooks(
        insertResult.firstInsertedRowId != null && insertResult.lastInsertedRowId != null
          ? {
              startRowId: insertResult.firstInsertedRowId,
              endRowId: insertResult.lastInsertedRowId,
            }
          : null,
        inboundMessages,
      );
      if (
        projection.pending_raw_events === 0 &&
        insertResult.firstInsertedRowId != null &&
        insertResult.lastInsertedRowId != null
      ) {
        await releaseMessageReceivedHooksForRange({
          startRowId: insertResult.firstInsertedRowId,
          endRowId: insertResult.lastInsertedRowId,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      signalLogger.warn("realtime ingest failed", { accountKey, error: message });
      if (isSqliteBusyError(error)) {
        queueNativeTriggeredSync(
          db,
          "signal",
          accountKey,
          "signal_realtime_busy_fallback",
          schedulers.wakeIngest,
        );
      }
    }
  };

  const updateWhatsAppCheckpointFromRealtime = (accountKey: string) => {
    const checkpoint = db.getCheckpoint("whatsapp", accountKey);
    const projection = db.getProjectionBacklog();
    const sourceCursor = safeParseJsonRecord(
      checkpoint?.source_cursor_json ?? null,
      "sync_checkpoints.source_cursor_json",
    );
    db.upsertCheckpoint({
      platform: "whatsapp",
      accountKey,
      syncMode: checkpoint?.sync_mode ?? "incremental",
      sourceCursor,
      rawIngestWatermark: projection.max_raw_event_rowid,
      lastSuccessAt: now(),
      lastErrorSummary: null,
    });
  };

  const ingestWhatsAppRealtimeSnapshot = async (
    accountKey: string,
    snapshot: WhatsAppSnapshot,
    trigger: string,
  ): Promise<void> => {
    try {
      const rawEvents = withRawEventAcquisitionMode(
        buildWhatsAppRawEventsFromSnapshot({
          accountKey,
          snapshot,
        }),
        "realtime",
      );
      if (rawEvents.length === 0) {
        return;
      }

      db.upsertSourceAccounts([
        {
          platform: "whatsapp",
          accountKey,
          displayName: "WhatsApp",
        },
      ]);
      const insertResult = db.insertRawEvents(rawEvents);
      if (
        realtimeProjectionEnabled &&
        insertResult.firstInsertedRowId != null &&
        insertResult.lastInsertedRowId != null
      ) {
        projectRealtimeRange(db, {
          startRowId: insertResult.firstInsertedRowId,
          endRowId: insertResult.lastInsertedRowId,
          batchSize: realtimeProjectionBatchSize,
        });
      }
      const projection = db.getProjectionBacklog();
      if (projection.pending_raw_events > 0) {
        queueProjectionRun(trigger, undefined, { delayMs: deferredProjectionCoalesceMs });
      }
      if (insertResult.insertedCount > 0) {
        updateWhatsAppCheckpointFromRealtime(accountKey);
      }

      const inboundMessages = collectInboundMessageHookPayloads(
        trigger,
        insertResult.insertedRows,
        isInboundMessageEvent,
      );
      queueMessageReceivedHooks(
        insertResult.firstInsertedRowId != null && insertResult.lastInsertedRowId != null
          ? {
              startRowId: insertResult.firstInsertedRowId,
              endRowId: insertResult.lastInsertedRowId,
            }
          : null,
        inboundMessages,
      );
      if (
        projection.pending_raw_events === 0 &&
        insertResult.firstInsertedRowId != null &&
        insertResult.lastInsertedRowId != null
      ) {
        await releaseMessageReceivedHooksForRange({
          startRowId: insertResult.firstInsertedRowId,
          endRowId: insertResult.lastInsertedRowId,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      whatsAppLogger.warn("realtime ingest failed", { accountKey, error: message });
      if (isSqliteBusyError(error)) {
        queueNativeTriggeredSync(
          db,
          "whatsapp",
          accountKey,
          "whatsapp_realtime_busy_fallback",
          schedulers.wakeIngest,
        );
      }
    }
  };

  const applyReceiptToRealtimeSnapshot = async (
    accountKey: string,
    receipt: WhatsAppReceiptSnapshot,
  ): Promise<void> => {
    const message = db.findMessageByPlatformKey(
      "whatsapp",
      accountKey,
      `${receipt.chatJID.toLowerCase()}:${receipt.messageID}`,
    );
    if (!message) {
      return;
    }

    await ingestWhatsAppRealtimeSnapshot(
      accountKey,
      {
        messages: [
          {
            messageID: receipt.messageID,
            chatJID: receipt.chatJID,
            senderJID: message.sender_source_key?.replace(/^whatsapp:/, "") ?? receipt.chatJID,
            fromMe: receipt.fromMe,
            timestamp: message.sent_at ?? now(),
            text: message.content ?? "",
            status: receipt.status ?? message.status ?? null,
            deliveredAt: receipt.deliveredAt ?? message.delivered_at ?? null,
            readAt: receipt.readAt ?? message.read_at ?? null,
          },
        ],
      },
      `whatsapp_receipt:${accountKey}`,
    );
  };

  const handleWhatsAppRealtimeEvent = async (
    accountKey: string,
    event: WhatsAppHelperEventEnvelope,
  ): Promise<void> => {
    switch (event.event) {
      case "contact_upsert": {
        const contact = event.data as WhatsAppHelperEventEnvelope<"contact_upsert">["data"];
        await ingestWhatsAppRealtimeSnapshot(
          accountKey,
          {
            contacts: [contact],
          },
          `whatsapp_realtime:${accountKey}`,
        );
        return;
      }
      case "chat_upsert": {
        const chat = event.data as WhatsAppHelperEventEnvelope<"chat_upsert">["data"];
        await ingestWhatsAppRealtimeSnapshot(
          accountKey,
          {
            chats: [chat],
          },
          `whatsapp_realtime:${accountKey}`,
        );
        return;
      }
      case "message_upsert": {
        const message = event.data as WhatsAppHelperEventEnvelope<"message_upsert">["data"];
        await ingestWhatsAppRealtimeSnapshot(
          accountKey,
          {
            messages: [message],
          },
          `whatsapp_realtime:${accountKey}`,
        );
        return;
      }
      case "receipt_update":
        await applyReceiptToRealtimeSnapshot(
          accountKey,
          event.data as WhatsAppHelperEventEnvelope<"receipt_update">["data"],
        );
        return;
      case "history_sync":
        await ingestWhatsAppRealtimeSnapshot(
          accountKey,
          event.data as WhatsAppHelperEventEnvelope<"history_sync">["data"],
          `whatsapp_history_sync:${accountKey}`,
        );
        return;
      default:
        return;
    }
  };

  const sendWhatsAppOutboundMessage = async (
    message: OutboundMessageRow,
    realtime: WhatsAppRealtimeSupervisor,
  ): Promise<{
    transport: "session";
    result: { messageID: string; chatJID: string; timestamp: number };
  }> => {
    const session =
      realtime.getSession(message.account_key) ??
      (await realtime.waitForConnected(message.account_key, WHATSAPP_SEND_SESSION_WAIT_MS));
    if (!session?.isConnected()) {
      throw new Error(`WhatsApp session is not connected for '${message.account_key}'`);
    }

    return {
      transport: "session",
      result: await session.sendText(message.target, message.text),
    };
  };

  const sendDiscordOutboundMessage = async (
    message: OutboundMessageRow,
    realtime: DiscordRealtimeSupervisor,
  ): Promise<{
    transport: "session" | "fallback";
    result: Awaited<ReturnType<DiscordApiClient["sendMessage"]>>;
    currentUser: Awaited<ReturnType<DiscordApiClient["getCurrentUser"]>>;
    channel: Awaited<ReturnType<DiscordApiClient["getChannel"]>>;
  }> => {
    const secret = loadIntegrationSecret("discord", message.account_key).secret;
    if (typeof secret.token !== "string" || secret.token.trim().length === 0) {
      throw new Error(`Discord integration '${message.account_key}' is missing a token`);
    }

    const client = new DiscordApiClient({ token: secret.token });
    const session = realtime.getSession(message.account_key);
    const transport = session?.isConnected() ? "session" : "fallback";
    const [currentUser, channel] = await Promise.all([
      client.getCurrentUser(),
      client.getChannel(message.target),
    ]);
    if (!isDiscordDmChannel(channel)) {
      throw new Error(`Discord DM-only mode cannot send to non-DM target '${message.target}'`);
    }
    const result = session?.isConnected()
      ? await session.sendMessage(message.target, message.text)
      : await client.sendMessage(message.target, message.text);

    return {
      transport,
      result,
      currentUser,
      channel,
    };
  };

  const drainIngestQueue = () => {
    ingestDrainScheduled = false;
    ingestDrainDueAt = null;
    if (isUpdateShutdownRequested) {
      return;
    }
    if (isProcessingProjection) {
      scheduleIngestDrain(QUEUE_DRAIN_RETRY_DELAY_MS);
      return;
    }
    while (activeIngestRuns.size < currentIngestConcurrency()) {
      let currentRun: ReturnType<typeof db.claimNextQueuedRun>;
      try {
        currentRun = db.withBusyTimeoutSync(DAEMON_STATUS_BUSY_TIMEOUT_MS, () =>
          db.claimNextQueuedRun(["sync", "sync_resume"], "ingesting"),
        );
      } catch (error) {
        if (!isSqliteBusyError(error)) {
          throw error;
        }
        daemonLogger.warn("ingest drain skipped because SQLite is busy");
        scheduleIngestDrain(QUEUE_DRAIN_RETRY_DELAY_MS);
        return;
      }
      if (!currentRun) {
        let nextScheduledAt: number | null = null;
        try {
          nextScheduledAt = db.withBusyTimeoutSync(DAEMON_STATUS_BUSY_TIMEOUT_MS, () =>
            db.getNextQueuedRunScheduledAt(["sync", "sync_resume"]),
          );
        } catch (error) {
          if (!isSqliteBusyError(error)) {
            throw error;
          }
          daemonLogger.warn("ingest drain skipped because SQLite is busy");
          scheduleIngestDrain(QUEUE_DRAIN_RETRY_DELAY_MS);
          return;
        }
        if (nextScheduledAt != null) {
          scheduleIngestDrain(Math.max(QUEUE_DRAIN_RETRY_DELAY_MS, nextScheduledAt - now()));
        }
        break;
      }

      activeIngestRunTargets.set(currentRun.id, {
        platform: currentRun.platform,
        accountKey: currentRun.account_key,
      });
      const promise = processIngestRun(currentRun).finally(() => {
        activeIngestRuns.delete(currentRun.id);
        activeIngestRunTargets.delete(currentRun.id);
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
      drainIngestQueue();
    }, normalizedDelayMs);
  };

  const drainOutboundQueue = () => {
    outboundDrainScheduled = false;
    if (isUpdateShutdownRequested) {
      return;
    }
    if (activeOutboundSend) {
      return;
    }

    const message = db.claimNextOutboundMessage();
    if (!message) {
      return;
    }

    activeOutboundSend = (async () => {
      try {
        if (message.platform === "discord") {
          const sendResult = await sendDiscordOutboundMessage(message, discordRealtime);
          await ingestDiscordRealtimeRawEvents(
            message.account_key,
            [
              buildDiscordConversationEvent({
                accountKey: message.account_key,
                observedAt: now(),
                channel: sendResult.channel,
                currentUser: sendResult.currentUser,
              }),
              buildDiscordMessageEvent({
                accountKey: message.account_key,
                observedAt: now(),
                channel: sendResult.channel,
                message: sendResult.result,
                currentUserId: sendResult.currentUser.id,
              }),
            ],
            `discord_send:${message.id}`,
            sendResult.currentUser.global_name?.trim() || sendResult.currentUser.username,
          );
          db.completeOutboundMessage(message.id);
          await emitMessageSentHook(message, {
            transport: sendResult.transport,
            sentAt: Date.parse(sendResult.result.timestamp),
            providerMessageId: sendResult.result.id,
            conversationExternalId: sendResult.result.channel_id,
          });
          return;
        }

        if (message.platform === "signal") {
          const sendResult = await sendSignalOutboundMessage(message, signalRealtime);
          db.completeOutboundMessage(message.id);
          await emitMessageSentHook(message, {
            transport: sendResult.transport,
            sentAt: sendResult.timestamp,
          });
          if (sendResult.transport === "session") {
            scheduleSignalSendEchoCatchup(message, sendResult.timestamp);
            return;
          }
          if (!db.hasQueuedOrRunningRun(message.platform, message.account_key)) {
            db.queueSyncRun({
              platform: message.platform,
              accountKey: message.account_key,
              runType: "sync",
              trigger: "outbound_send_completed",
              details: {
                source: message.platform,
                accountKey: message.account_key,
                trigger: "outbound_send_completed",
                outboundMessageId: message.id,
              },
            });
            scheduleIngestDrain();
          }
          return;
        }

        if (message.platform === "whatsapp") {
          const sendResult = await sendWhatsAppOutboundMessage(message, whatsAppRealtime);
          db.completeOutboundMessage(message.id);
          await emitMessageSentHook(message, {
            transport: sendResult.transport,
            sentAt: sendResult.result.timestamp,
            providerMessageId: sendResult.result.messageID,
            conversationExternalId: sendResult.result.chatJID,
          });
          return;
        }
        db.failOutboundMessage({
          id: message.id,
          retryable: false,
          error: `Unsupported outbound platform: ${message.platform}`,
        });
        return;
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        const resolvedLogger =
          message.platform === "discord"
            ? discordLogger
            : message.platform === "signal"
              ? signalLogger
              : whatsAppLogger;
        resolvedLogger.warn("outbound send failed", {
          accountKey: message.account_key,
          outboundMessageId: message.id,
          error: messageText,
        });
        if (message.platform === "discord" && isDiscordAuthInvalidationError(error)) {
          blockDiscordIntegration(db, message.account_key, messageText);
          requestDiscordRealtimeReconcile();
        }
        db.failOutboundMessage({
          id: message.id,
          retryable:
            message.platform === "signal"
              ? isRetryableSignalSendError(messageText)
              : message.platform === "discord"
                ? !isDiscordAuthInvalidationError(error)
                : true,
          error: messageText,
        });
      } finally {
        activeOutboundSend = null;
        scheduleOutboundDrain();
        maybeFinishUpdateShutdown();
      }
    })();
  };

  const scheduleOutboundDrain = () => {
    if (outboundDrainScheduled) {
      return;
    }
    outboundDrainScheduled = true;
    setImmediate(drainOutboundQueue);
  };

  const drainProjectionQueue = () => {
    projectionDrainScheduled = false;
    projectionDrainDueAt = null;
    if (isUpdateShutdownRequested) {
      return;
    }
    if (isProcessingProjection) {
      return;
    }
    if (bootstrap.state !== "ready") {
      scheduleProjectionDrain(QUEUE_DRAIN_RETRY_DELAY_MS);
      return;
    }
    if (activeIngestRuns.size > 0) {
      scheduleProjectionDrain(QUEUE_DRAIN_RETRY_DELAY_MS);
      return;
    }

    let currentRun: ReturnType<typeof db.claimNextQueuedRun>;
    try {
      currentRun = db.withBusyTimeoutSync(DAEMON_STATUS_BUSY_TIMEOUT_MS, () =>
        db.claimNextQueuedRun(["project", "rebuild"], "projecting"),
      );
    } catch (error) {
      if (!isSqliteBusyError(error)) {
        throw error;
      }
      daemonLogger.warn("projection drain skipped because SQLite is busy");
      scheduleProjectionDrain(QUEUE_DRAIN_RETRY_DELAY_MS);
      return;
    }
    if (!currentRun) {
      let nextScheduledAt: number | null = null;
      try {
        nextScheduledAt = db.withBusyTimeoutSync(DAEMON_STATUS_BUSY_TIMEOUT_MS, () =>
          db.getNextQueuedRunScheduledAt(["project", "rebuild"]),
        );
      } catch (error) {
        if (!isSqliteBusyError(error)) {
          throw error;
        }
        daemonLogger.warn("projection drain skipped because SQLite is busy");
        scheduleProjectionDrain(QUEUE_DRAIN_RETRY_DELAY_MS);
        return;
      }
      if (nextScheduledAt != null) {
        scheduleProjectionDrain(Math.max(QUEUE_DRAIN_RETRY_DELAY_MS, nextScheduledAt - now()));
      }
      return;
    }

    isProcessingProjection = true;
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
      drainProjectionQueue();
    }, normalizedDelayMs);
  };

  const schedulers = {
    wakeIngest: scheduleIngestDrain,
    wakeOutbound: scheduleOutboundDrain,
    wakeProjection: scheduleProjectionDrain,
  };
  const queueDebouncedNativeSync = createDebouncedSyncEnqueuer(db, schedulers.wakeIngest);
  const discordRealtime = new DiscordRealtimeSupervisor({
    onEvent: (accountKey, event) => {
      void handleDiscordRealtimeEvent(accountKey, event);
    },
    onAuthInvalidated: (accountKey, _status, reason) => {
      blockDiscordIntegration(db, accountKey, reason);
      requestDiscordRealtimeReconcile();
    },
    onConnected: (accountKey, _status, reconnected) => {
      if (!reconnected) {
        return;
      }
      queueNativeTriggeredSync(
        db,
        "discord",
        accountKey,
        "discord_realtime_reconnected",
        schedulers.wakeIngest,
      );
    },
  });
  const slackRealtime = new SlackRealtimeSupervisor({
    onEvent: (accountKey, event) => {
      void handleSlackRealtimeEvent(accountKey, event);
    },
    onConnected: (accountKey, _status, reconnected) => {
      if (!reconnected) {
        return;
      }
      queueNativeTriggeredSync(
        db,
        "slack",
        accountKey,
        "slack_realtime_reconnected",
        schedulers.wakeIngest,
      );
    },
  });
  const stopNativeWatcher = (watcher: FSWatcher | ChildProcess) => {
    if ("close" in watcher && typeof watcher.close === "function") {
      watcher.close();
      return;
    }
    if ("kill" in watcher && typeof watcher.kill === "function") {
      watcher.kill("SIGTERM");
    }
  };
  const shouldStartLocalWatcher = (platform: "contacts" | "imessage") => {
    return shouldRunLocalWatcherForState(
      db.getAppMetadata(),
      db.getIntegrationState(platform, "local"),
    );
  };
  const reconcileLocalWatchers = () => {
    if (process.platform !== "darwin") {
      return;
    }

    const desiredPlatforms = [
      ...(shouldStartLocalWatcher("imessage") ? (["imessage", "callhistory"] as const) : []),
      ...(shouldStartLocalWatcher("contacts") ? (["contacts"] as const) : []),
    ];

    for (const [platform, watcher] of nativeWatchers.entries()) {
      if (desiredPlatforms.includes(platform)) {
        continue;
      }
      stopNativeWatcher(watcher);
      nativeWatchers.delete(platform);
    }

    for (const platform of desiredPlatforms) {
      if (nativeWatchers.has(platform)) {
        continue;
      }
      const watcher =
        platform === "imessage"
          ? startIMessageWatcher(db, queueDebouncedNativeSync)
          : platform === "callhistory"
            ? startCallHistoryWatcher(db, queueDebouncedNativeSync)
            : startContactsWatcher(db, queueDebouncedNativeSync);
      if (watcher) {
        nativeWatchers.set(platform, watcher);
      }
    }
  };
  const linkedInRealtime = new LinkedInRealtimeSupervisor({
    onEvent: (accountKey, event, userEntityUrn) => {
      void ingestLinkedInRealtimeEnvelope(accountKey, event, userEntityUrn);
    },
    onConnected: (accountKey, _status, reconnected) => {
      if (!reconnected) {
        return;
      }
      queueNativeTriggeredSync(
        db,
        "linkedin",
        accountKey,
        "linkedin_realtime_reconnected",
        schedulers.wakeIngest,
      );
    },
  });
  const signalRealtime = new SignalRealtimeSupervisor({
    onMessage: (accountKey, message) => {
      void ingestSignalRealtimeMessages(accountKey, [message]);
    },
    onConnected: (accountKey, _status, reconnected) => {
      if (!reconnected) {
        return;
      }
      if (suppressNextSignalReconnectSync.has(accountKey)) {
        suppressNextSignalReconnectSync.delete(accountKey);
        return;
      }
      const queuedAt = now();
      const lastQueuedAt = lastSignalReconnectSyncQueuedAt.get(accountKey) ?? 0;
      if (queuedAt - lastQueuedAt < signalReconnectSyncCooldownMs) {
        return;
      }
      lastSignalReconnectSyncQueuedAt.set(accountKey, queuedAt);
      queueNativeTriggeredSync(
        db,
        "signal",
        accountKey,
        "signal_realtime_reconnected",
        schedulers.wakeIngest,
      );
    },
  });
  const whatsAppRealtime = new WhatsAppRealtimeSupervisor({
    onEvent: (accountKey, event) => {
      void handleWhatsAppRealtimeEvent(accountKey, event);
    },
    onConnected: (accountKey, _status, reconnected) => {
      if (!reconnected) {
        return;
      }
      queueNativeTriggeredSync(
        db,
        "whatsapp",
        accountKey,
        "whatsapp_realtime_reconnected",
        schedulers.wakeIngest,
      );
    },
  });

  const reconcileSlackRealtimeSessions = async () => {
    const { desired, degraded } = await collectDesiredSlackSessions(db);
    slackRealtime.reconcile(desired, degraded);
  };

  const reconcileDiscordRealtimeSessions = async () => {
    const { desired, degraded } = await collectDesiredDiscordSessions(db);
    discordRealtime.reconcile(desired, degraded);
  };

  const requestDiscordRealtimeReconcile = () => {
    if (!shouldRunRealtimePlatform("discord")) {
      discordRealtime.stopAll();
      return;
    }
    if (discordRealtimeReconcilePromise) {
      discordRealtimeReconcileQueued = true;
      return;
    }

    discordRealtimeReconcilePromise = reconcileDiscordRealtimeSessions()
      .catch((error) => {
        discordLogger.warn("realtime reconcile failed", error);
      })
      .finally(() => {
        discordRealtimeReconcilePromise = null;
        if (discordRealtimeReconcileQueued) {
          discordRealtimeReconcileQueued = false;
          requestDiscordRealtimeReconcile();
        }
      });
  };

  const requestSlackRealtimeReconcile = () => {
    if (!shouldRunRealtimePlatform("slack")) {
      slackRealtime.stopAll();
      return;
    }
    if (slackRealtimeReconcilePromise) {
      slackRealtimeReconcileQueued = true;
      return;
    }

    slackRealtimeReconcilePromise = reconcileSlackRealtimeSessions()
      .catch((error) => {
        slackLogger.warn("realtime reconcile failed", error);
      })
      .finally(() => {
        slackRealtimeReconcilePromise = null;
        if (slackRealtimeReconcileQueued) {
          slackRealtimeReconcileQueued = false;
          requestSlackRealtimeReconcile();
        }
      });
  };

  const reconcileLinkedInRealtimeSessions = async () => {
    const { desired, degraded } = await collectDesiredLinkedInSessions(db);
    linkedInRealtime.reconcile(desired, degraded);
  };

  const requestLinkedInRealtimeReconcile = () => {
    if (!shouldRunRealtimePlatform("linkedin")) {
      linkedInRealtime.stopAll();
      return;
    }
    if (linkedInRealtimeReconcilePromise) {
      linkedInRealtimeReconcileQueued = true;
      return;
    }

    linkedInRealtimeReconcilePromise = reconcileLinkedInRealtimeSessions()
      .catch((error) => {
        linkedInLogger.warn("realtime reconcile failed", error);
      })
      .finally(() => {
        linkedInRealtimeReconcilePromise = null;
        if (linkedInRealtimeReconcileQueued) {
          linkedInRealtimeReconcileQueued = false;
          requestLinkedInRealtimeReconcile();
        }
      });
  };

  const reconcileSignalRealtimeSessions = async () => {
    const { desired, degraded } = await collectDesiredSignalSessions(db);
    signalRealtime.reconcile(desired, degraded);
  };

  const requestSignalRealtimeReconcile = () => {
    if (!shouldRunRealtimePlatform("signal")) {
      signalRealtime.stopAll();
      return;
    }
    if (signalRealtimeReconcilePromise) {
      signalRealtimeReconcileQueued = true;
      return;
    }

    signalRealtimeReconcilePromise = reconcileSignalRealtimeSessions()
      .catch((error) => {
        signalLogger.warn("realtime reconcile failed", error);
      })
      .finally(() => {
        signalRealtimeReconcilePromise = null;
        if (signalRealtimeReconcileQueued) {
          signalRealtimeReconcileQueued = false;
          requestSignalRealtimeReconcile();
        }
      });
  };

  const reconcileWhatsAppRealtimeSessions = async () => {
    const { desired, degraded } = await collectDesiredWhatsAppSessions(db);
    whatsAppRealtime.reconcile(desired, degraded);
  };

  const requestWhatsAppRealtimeReconcile = () => {
    if (!shouldRunRealtimePlatform("whatsapp")) {
      whatsAppRealtime.stopAll();
      return;
    }
    if (whatsAppRealtimeReconcilePromise) {
      whatsAppRealtimeReconcileQueued = true;
      return;
    }

    whatsAppRealtimeReconcilePromise = reconcileWhatsAppRealtimeSessions()
      .catch((error) => {
        whatsAppLogger.warn("realtime reconcile failed", error);
      })
      .finally(() => {
        whatsAppRealtimeReconcilePromise = null;
        if (whatsAppRealtimeReconcileQueued) {
          whatsAppRealtimeReconcileQueued = false;
          requestWhatsAppRealtimeReconcile();
        }
      });
  };

  db.failInProgressRuns("Recovered stale in-progress sync after daemon restart");
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

  const heartbeat = setInterval(() => {
    try {
      daemonLease.heartbeat();
      db.withBusyTimeoutSync(DAEMON_STATUS_BUSY_TIMEOUT_MS, () => {
        db.upsertDaemonState({
          pid: process.pid,
          startedAt,
          updatedAt: now(),
          status: "running",
          version: DAEMON_VERSION,
          details: daemonIdentity,
        });
      });
    } catch (error) {
      if (!isSqliteBusyError(error)) {
        throw error;
      }
      daemonLogger.warn("heartbeat skipped because SQLite is busy");
    }
  }, SINGLETON_LOCK_HEARTBEAT_MS);

  const writeMenuBarStatus = () => {
    try {
      db.withBusyTimeoutSync(DAEMON_STATUS_BUSY_TIMEOUT_MS, () => {
        writeMenuBarStatusSnapshot(db, {
          discordRealtime,
          slackRealtime,
          linkedInRealtime,
          signalRealtime,
          whatsAppRealtime,
          bootstrap,
        });
      });
    } catch (error) {
      if (!isSqliteBusyError(error)) {
        daemonLogger.warn("menu bar status cache write failed", error);
        return;
      }
      daemonLogger.warn("menu bar status cache write skipped because SQLite is busy");
    }
  };
  writeMenuBarStatus();
  const menuBarStatusLoop = setInterval(writeMenuBarStatus, MENU_BAR_STATUS_WRITE_INTERVAL_MS);

  const queueAutoSyncRuns = (trigger: string) => {
    if (isUpdateShutdownRequested) {
      return;
    }
    if (trigger === "scheduler" && isIngestThrottled()) {
      daemonLogger.info("autosync scheduler skipped during interactive backfill pressure", {
        interactive: isInteractiveActive(),
        backfillPressure: isBackfillPressureActive(),
        activeIngestRuns: activeIngestRuns.size,
      });
      return;
    }
    try {
      db.withBusyTimeoutSync(DAEMON_STATUS_BUSY_TIMEOUT_MS, () => {
        if (trigger === "scheduler" && bootstrap.state !== "ready") {
          return;
        }
        const autoSyncTargets = getAutoSyncTargets(db);
        let queuedAny = false;
        const queuedAt = now();
        for (const target of autoSyncTargets) {
          if (trigger === "scheduler") {
            const targetKey = `${target.platform}:${target.accountKey}`;
            const lastQueuedAt = lastAutoSyncQueuedAt.get(targetKey) ?? startedAt;
            if (queuedAt - lastQueuedAt < getAutoSyncIntervalMs(target.platform)) {
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

        if (queuedAny) {
          schedulers.wakeIngest();
        }
      });
    } catch (error) {
      if (!isSqliteBusyError(error)) {
        throw error;
      }
      daemonLogger.warn("autosync queue skipped because SQLite is busy", { trigger });
    }
  };

  const queueProjectionRun = (
    trigger: string,
    range?: { startRowId: number; endRowId: number },
    options?: { delayMs?: number },
  ) => {
    if (isUpdateShutdownRequested) {
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
          scheduleProjectionDrain(options?.delayMs ?? deferredProjectionCoalesceMs);
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
  scheduleOutboundDrain();

  const stopRealtimeAndWatchers = () => {
    for (const watcher of nativeWatchers.values()) {
      stopNativeWatcher(watcher);
    }
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
    if (
      deadlineReached ||
      (activeIngestRuns.size === 0 && !activeOutboundSend && !isProcessingProjection)
    ) {
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
      activeOutboundSend: Boolean(activeOutboundSend),
      isProcessingProjection,
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
      await refreshManagedIntegrationStates(db);
      if (shouldBootstrapLocalIntegrations(db.getAppMetadata())) {
        refreshLocalIntegrationStates(db);
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
    } catch (error) {
      daemonLogger.warn("daemon bootstrap failed", error);
      completeBootstrap("failed", error);
    }
  };

  async function processIngestRun(
    currentRun: NonNullable<ReturnType<typeof db.claimNextQueuedRun>>,
  ) {
    const ingestStartedAt = now();
    daemonLogger.info("ingest run started", {
      runId: currentRun.id,
      platform: currentRun.platform,
      accountKey: currentRun.account_key,
      trigger: currentRun.trigger,
      runType: currentRun.run_type,
    });
    try {
      if (
        (currentRun.run_type !== "sync" && currentRun.run_type !== "sync_resume") ||
        !currentRun.platform
      ) {
        db.failRun(
          currentRun.id,
          `Unsupported ingest run target: ${currentRun.run_type}:${currentRun.platform ?? "none"}`,
        );
        return;
      }
      if (!isAdapterPlatform(currentRun.platform)) {
        db.failRun(currentRun.id, `No adapter registered for platform: ${currentRun.platform}`);
        return;
      }

      const platform = currentRun.platform;
      const accountKey = currentRun.account_key ?? getDefaultAccountKeyForPlatform(platform);
      const checkpoint = db.getCheckpoint(currentRun.platform, accountKey);
      const sourceCursor = safeParseJsonRecord(
        checkpoint?.source_cursor_json ?? null,
        "sync_checkpoints.source_cursor_json",
      );
      const envOverrides = buildAdapterInvocationEnv({
        platform,
        checkpointSourceCursorJson: checkpoint?.source_cursor_json ?? null,
        proofs: selectAdapterInvocationProofs({
          platform,
          proofs: db.listSyncProofs(platform, accountKey),
          sourceCursor,
        }),
      });

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
      let insertResult: ReturnType<typeof db.insertRawEvents> = {
        insertedCount: 0,
        insertedEvents: [],
        insertedRows: [],
        firstInsertedRowId: null,
        lastInsertedRowId: null,
      };

      if (platform === "whatsapp") {
        const session =
          whatsAppRealtime.getSession(accountKey) ??
          (await whatsAppRealtime.waitForConnected(accountKey, 10_000));
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
        const sinceMs =
          cursor != null
            ? (whatsappCursor.resyncSinceMs ?? null)
            : bundleSyncMode === "incremental"
              ? (checkpoint?.last_success_at ?? whatsappCursor.lastSyncAt ?? null)
              : null;
        const resyncStartedAt = whatsappCursor.resyncStartedAt ?? ingestStartedAt;
        const pageBudget = getWhatsAppResyncPageBudget();
        let pageCount = 0;
        let resyncStats = whatsappCursor.resyncStats ?? emptyWhatsAppResyncStats();
        let resyncCoverage = whatsappCursor.resyncCoverage ?? {
          oldestMessageAt: null,
          newestMessageAt: null,
        };
        let hasMore = false;
        let lastCompletedAt = now();
        do {
          const pageFetchStartedAt = now();
          const page = await session.resync({
            cursor,
            sinceMs,
            limit: 1000,
          });
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
          const pageInsertResult = db.insertRawEvents(rawEvents);
          rawEventInsertMs += now() - pageInsertStartedAt;
          insertResult = {
            insertedCount: insertResult.insertedCount + pageInsertResult.insertedCount,
            insertedEvents: [...insertResult.insertedEvents, ...pageInsertResult.insertedEvents],
            insertedRows: [...insertResult.insertedRows, ...pageInsertResult.insertedRows],
            firstInsertedRowId:
              insertResult.firstInsertedRowId == null
                ? pageInsertResult.firstInsertedRowId
                : pageInsertResult.firstInsertedRowId == null
                  ? insertResult.firstInsertedRowId
                  : Math.min(insertResult.firstInsertedRowId, pageInsertResult.firstInsertedRowId),
            lastInsertedRowId:
              insertResult.lastInsertedRowId == null
                ? pageInsertResult.lastInsertedRowId
                : pageInsertResult.lastInsertedRowId == null
                  ? insertResult.lastInsertedRowId
                  : Math.max(insertResult.lastInsertedRowId, pageInsertResult.lastInsertedRowId),
          };
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
        const bundle =
          platform === "signal"
            ? await runSignalSyncExclusively(
                accountKey,
                async () => await runAdapter(platform, accountKey, envOverrides),
              )
            : await runAdapter(platform, accountKey, envOverrides);
        adapterFetchMs = now() - adapterStartedAt;
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
        insertResult = db.insertRawEvents(withRawEventAcquisitionMode(bundle.rawEvents, "sync"));
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
          realtimeProjectionEnabled,
          firstInsertedRowId: insertResult.firstInsertedRowId,
          lastInsertedRowId: insertResult.lastInsertedRowId,
        })
      ) {
        projectRealtimeRange(db, {
          startRowId: insertResult.firstInsertedRowId!,
          endRowId: insertResult.lastInsertedRowId!,
          batchSize: realtimeProjectionBatchSize,
          includeOverview: false,
        });
      }
      const afterRealtimeProjection = now();
      const inboundMessages = collectInboundMessageHookPayloads(
        currentRun.id,
        insertResult.insertedRows,
        isInboundMessageEvent,
      );
      queueMessageReceivedHooks(
        insertResult.firstInsertedRowId != null && insertResult.lastInsertedRowId != null
          ? {
              startRowId: insertResult.firstInsertedRowId,
              endRowId: insertResult.lastInsertedRowId,
            }
          : null,
        inboundMessages,
      );
      if (platform === "signal") {
        for (const rawEvent of insertResult.insertedEvents) {
          if (rawEvent.entityKind !== "message" || rawEvent.eventKind !== "created") {
            continue;
          }
          const payload = rawEvent.payload as Record<string, unknown>;
          if (payload.isFromMe !== true || typeof payload.content !== "string") {
            continue;
          }
          const sourceConversationKey =
            typeof payload.sourceConversationKey === "string"
              ? payload.sourceConversationKey.replace(/^signal:/, "")
              : null;
          const sentAt = typeof payload.sentAt === "number" ? payload.sentAt : 0;
          clearSignalSendEcho(accountKey, (echo) => {
            const sameThread = !echo.threadId || echo.threadId === sourceConversationKey;
            const sameText = echo.text.trim() === payload.content;
            const nearTimestamp = sentAt > 0 ? Math.abs(echo.timestamp - sentAt) < 30_000 : true;
            return sameThread && sameText && nearTimestamp;
          });
        }
      }

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
        const shouldDeferContinuationProjection =
          bundleHasMore &&
          projection.pending_raw_events < continuationProjectionBacklogEvents &&
          now() - lastContinuationProjectionAt < continuationProjectionIntervalMs;

        if (shouldDeferContinuationProjection) {
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
            lastContinuationProjectionQueuedAt.set(continuationProjectionKey, now());
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
      db.finishRun(currentRun.id, {
        ingested: ingestedCount,
        insertedRawEvents: insertResult.insertedCount,
        projectionQueued,
        hasMore: bundleHasMore,
        syncMode: checkpointSyncMode,
        timings,
        ...(bundleContinuation ? { continuation: bundleContinuation } : {}),
        ...(runDiagnostics ? { diagnostics: runDiagnostics } : {}),
      });
      if (platform === "signal") {
        requestSignalRealtimeReconcile();
      }
      if (bundleHasMore && platform === "imessage") {
        backfillPressureUntil = now() + backfillPressureWindowMs;
      }
      if (bundleHasMore && !db.hasQueuedOrRunningRun(currentRun.platform, accountKey)) {
        db.queueSyncRun({
          platform: currentRun.platform,
          accountKey,
          runType: "sync_resume",
          trigger: "ingest_continue",
          delayMs: syncContinueDelayMs,
          details: {
            source: currentRun.platform,
            accountKey,
            trigger: "ingest_continue",
            ...(bundleContinuation ? { continuation: bundleContinuation } : {}),
          },
        });
        schedulers.wakeIngest(syncContinueDelayMs);
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (isSqliteBusyError(error)) {
        daemonLogger.warn("ingest run deferred because SQLite is busy", {
          runId: currentRun.id,
          platform: currentRun.platform,
          accountKey: currentRun.account_key,
          retryDelayMs: SQLITE_BUSY_RUN_RETRY_DELAY_MS,
          error: errorMessage,
        });
        db.withBusyTimeoutSync(SQLITE_BUSY_RUN_RESCHEDULE_TIMEOUT_MS, () => {
          db.rescheduleRun(currentRun.id, SQLITE_BUSY_RUN_RETRY_DELAY_MS);
        });
        return;
      }
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
      db.failRun(currentRun.id, errorMessage);
      if (currentRun.platform === "signal") {
        requestSignalRealtimeReconcile();
      }
      await safeEmitHookEvent("sync.failed", {
        runId: currentRun.id,
        platform: currentRun.platform,
        runType: currentRun.run_type,
        stage: "ingest",
        error: errorMessage,
      });
    }
  }

  const processProjectionRun = async (
    currentRun: NonNullable<ReturnType<typeof db.claimNextQueuedRun>>,
  ) => {
    daemonLogger.info("projection run started", {
      runId: currentRun.id,
      trigger: currentRun.trigger,
      runType: currentRun.run_type,
    });
    try {
      const workerResult = await runProjectionWorkerProcess(currentRun, projectionBatchSize);
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
        queueProjectionRun(
          `projection_continue:${currentRun.id}`,
          {
            startRowId: deferredProjected.nextStartRowId,
            endRowId:
              deferredProjected.rangeEndRowId ??
              projectionDetails?.endRowId ??
              deferredProjected.projectionWatermark,
          },
          { delayMs: projectionContinueDelayMs },
        );
      }
      queueProjectionRun(`projection:${currentRun.run_type}`, undefined, {
        delayMs: projectionContinueDelayMs,
      });
      await safeEmitHookEvent("sync.completed", {
        runId: currentRun.id,
        platform: currentRun.platform,
        runType: currentRun.run_type,
        stage: "projection",
        projected,
        timings,
      });
      daemonLogger.info("projection run completed", {
        runId: currentRun.id,
        runType: currentRun.run_type,
        totalMs: timings.totalMs,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (isSqliteBusyError(error)) {
        daemonLogger.warn("projection run deferred because SQLite is busy", {
          runId: currentRun.id,
          runType: currentRun.run_type,
          retryDelayMs: SQLITE_BUSY_RUN_RETRY_DELAY_MS,
          error: errorMessage,
        });
        db.withBusyTimeoutSync(SQLITE_BUSY_RUN_RESCHEDULE_TIMEOUT_MS, () => {
          db.rescheduleRun(currentRun.id, SQLITE_BUSY_RUN_RETRY_DELAY_MS);
        });
        return;
      }
      daemonLogger.error("projection run failed", {
        runId: currentRun.id,
        runType: currentRun.run_type,
        error: errorMessage,
      });
      db.failRun(currentRun.id, errorMessage);
      await safeEmitHookEvent("sync.failed", {
        runId: currentRun.id,
        platform: currentRun.platform,
        runType: currentRun.run_type,
        stage: "projection",
        error: errorMessage,
      });
    } finally {
      isProcessingProjection = false;
      schedulers.wakeProjection();
      maybeFinishUpdateShutdown();
    }
  };

  const schedulerLoop = setInterval(() => {
    queueAutoSyncRuns("scheduler");
  }, getAutoSyncSchedulerTickMs());

  const updateLoop = setInterval(() => {
    scheduleUpdateCheck(false);
  }, UPDATE_CHECK_INTERVAL_MS);

  const server = createServer((socket) => {
    handleSocket(
      socket,
      db,
      activeAuthSessions,
      schedulers,
      discordRealtime,
      slackRealtime,
      linkedInRealtime,
      signalRealtime,
      whatsAppRealtime,
      bootstrap,
      () => {
        requestDiscordRealtimeReconcile();
        requestSlackRealtimeReconcile();
        requestLinkedInRealtimeReconcile();
        requestSignalRealtimeReconcile();
        requestWhatsAppRealtimeReconcile();
      },
      reconcileLocalWatchers,
      requestUpdateShutdown,
      markInteractive,
      () => isProcessingProjection || activeIngestRuns.size > 0 || activeOutboundSend !== null,
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(CUED_SOCKET_PATH, () => {
      server.off("error", reject);
      resolve();
    });
  });
  scheduleIngestDrain();
  scheduleProjectionDrain();
  setImmediate(() => {
    void runBootstrap();
  });

  const shutdown = () => {
    if (shutdownInitiated) {
      return;
    }
    shutdownInitiated = true;
    daemonLogger.info("daemon shutting down", { pid: process.pid });
    clearInterval(heartbeat);
    clearInterval(menuBarStatusLoop);
    clearInterval(schedulerLoop);
    clearInterval(updateLoop);
    if (projectionDrainTimer) {
      clearTimeout(projectionDrainTimer);
      projectionDrainTimer = null;
    }
    if (ingestDrainTimer) {
      clearTimeout(ingestDrainTimer);
      ingestDrainTimer = null;
    }
    stopRealtimeAndWatchers();
    for (const session of activeAuthSessions.values()) {
      session.child.kill("SIGTERM");
    }
    activeAuthSessions.clear();
    for (const echoes of pendingSignalSendEchoes.values()) {
      for (const echo of echoes) {
        clearTimeout(echo.timeout);
      }
    }
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

export function isDisconnectedSocketError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPIPE" || code === "ECONNRESET" || code === "ERR_STREAM_DESTROYED";
}

function handleSocketError(error: unknown): void {
  if (isDisconnectedSocketError(error)) {
    return;
  }
  daemonLogger.warn("daemon socket error", error);
}

function writeResponse(socket: Socket, response: DaemonResponse): void {
  if (socket.destroyed || !socket.writable) {
    return;
  }
  socket.write(`${JSON.stringify(response)}\n`, (error) => {
    if (error) {
      handleSocketError(error);
    }
  });
}

function handleSocket(
  socket: Socket,
  db: ReturnType<typeof openCuedDatabase>,
  activeAuthSessions: Map<string, { child: ChildProcess; platform: Platform; accountKey: string }>,
  schedulers: QueueSchedulers,
  discordRealtime: DiscordRealtimeSupervisor,
  slackRealtime: SlackRealtimeSupervisor,
  linkedInRealtime: LinkedInRealtimeSupervisor,
  signalRealtime: SignalRealtimeSupervisor,
  whatsAppRealtime: WhatsAppRealtimeSupervisor,
  bootstrap: DaemonBootstrapSnapshot,
  requestRealtimeReconcile: () => void,
  reconcileLocalWatchers: () => void,
  requestUpdateShutdown: () => { shuttingDown: boolean; requestedAt: number | null },
  markInteractive: () => void,
  isBackgroundWorkActive: () => boolean,
): void {
  let buffer = "";

  socket.on("error", handleSocketError);

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        let request: DaemonRequest | null = null;
        try {
          request = JSON.parse(line) as DaemonRequest;
        } catch {
          writeResponse(socket, {
            id: "unknown",
            ok: false,
            error: "Invalid JSON request",
          });
          newlineIndex = buffer.indexOf("\n");
          continue;
        }

        void dispatchRequest(
          db,
          request,
          activeAuthSessions,
          schedulers,
          discordRealtime,
          slackRealtime,
          linkedInRealtime,
          signalRealtime,
          whatsAppRealtime,
          bootstrap,
          requestRealtimeReconcile,
          reconcileLocalWatchers,
          requestUpdateShutdown,
          markInteractive,
          isBackgroundWorkActive,
        )
          .then((response) => writeResponse(socket, response))
          .catch((error) => {
            writeResponse(socket, {
              id: request?.id ?? "unknown",
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }

      newlineIndex = buffer.indexOf("\n");
    }
  });
}

async function dispatchRequest(
  db: ReturnType<typeof openCuedDatabase>,
  request: DaemonRequest,
  activeAuthSessions: Map<string, { child: ChildProcess; platform: Platform; accountKey: string }>,
  schedulers: QueueSchedulers,
  discordRealtime: DiscordRealtimeSupervisor,
  slackRealtime: SlackRealtimeSupervisor,
  linkedInRealtime: LinkedInRealtimeSupervisor,
  signalRealtime: SignalRealtimeSupervisor,
  whatsAppRealtime: WhatsAppRealtimeSupervisor,
  bootstrap: DaemonBootstrapSnapshot,
  requestRealtimeReconcile: () => void,
  reconcileLocalWatchers: () => void,
  requestUpdateShutdown: () => { shuttingDown: boolean; requestedAt: number | null },
  markInteractive: () => void,
  isBackgroundWorkActive: () => boolean,
): Promise<DaemonResponse> {
  try {
    const runQueueService = new RunQueueService(db, schedulers);
    const getIntegrationAuthService = async () => {
      const { IntegrationAuthService } = await import("../../platforms/core/auth/service.js");
      return new IntegrationAuthService(db);
    };
    switch (request.command) {
      case "ping":
        return {
          id: request.id,
          ok: true,
          result: {
            pong: true,
            pid: process.pid,
            version: DAEMON_VERSION,
            ...getDaemonIdentity(),
          },
        };
      case "status":
        markInteractive();
        if (isBackgroundWorkActive()) {
          const cached = readCachedDaemonStatusSnapshot();
          if (cached) {
            return {
              id: request.id,
              ok: true,
              result: {
                ...cached,
                daemonDbBusy: true,
                daemonDbBusyError: "Cued daemon is running background sync/projection work",
              },
            };
          }
          return {
            id: request.id,
            ok: true,
            result: buildDaemonBusyStatusSnapshot({
              discordRealtime,
              slackRealtime,
              linkedInRealtime,
              signalRealtime,
              whatsAppRealtime,
              socketPath: CUED_SOCKET_PATH,
              bootstrap,
              dbPath: db.dbPath,
              error: new Error("Cued daemon is running background sync/projection work"),
            }),
          };
        }
        try {
          return {
            id: request.id,
            ok: true,
            result: await db.withBusyTimeout(DAEMON_STATUS_BUSY_TIMEOUT_MS, () =>
              buildDaemonStatusSnapshot(db, {
                app: getAppStatusMetadata(db),
                discordRealtime,
                slackRealtime,
                linkedInRealtime,
                signalRealtime,
                whatsAppRealtime,
                socketPath: CUED_SOCKET_PATH,
                bootstrap,
              }),
            ),
          };
        } catch (error) {
          if (!isSqliteBusyError(error)) {
            throw error;
          }
          const cached = readCachedDaemonStatusSnapshot();
          if (cached) {
            return {
              id: request.id,
              ok: true,
              result: {
                ...cached,
                daemonDbBusy: true,
                daemonDbBusyError: error instanceof Error ? error.message : String(error),
              },
            };
          }
          return {
            id: request.id,
            ok: true,
            result: buildDaemonBusyStatusSnapshot({
              discordRealtime,
              slackRealtime,
              linkedInRealtime,
              signalRealtime,
              whatsAppRealtime,
              socketPath: CUED_SOCKET_PATH,
              bootstrap,
              dbPath: db.dbPath,
              error,
            }),
          };
        }
      case "doctor":
        markInteractive();
        if (isBackgroundWorkActive()) {
          return {
            id: request.id,
            ok: true,
            result: {
              ...buildDaemonBusyStatusSnapshot({
                discordRealtime,
                slackRealtime,
                linkedInRealtime,
                signalRealtime,
                whatsAppRealtime,
                socketPath: CUED_SOCKET_PATH,
                bootstrap,
                dbPath: db.dbPath,
                error: new Error("Cued daemon is running background sync/projection work"),
              }),
              checks: [],
              warnings: [
                {
                  id: "daemon_background_work_active",
                  severity: "warning",
                  message:
                    "Cued is syncing/projecting in the background; retry doctor after it yields.",
                },
              ],
            },
          };
        }
        try {
          return {
            id: request.id,
            ok: true,
            result: await db.withBusyTimeout(
              DAEMON_STATUS_BUSY_TIMEOUT_MS,
              async () =>
                await buildDoctorSnapshot(db, {
                  app: getAppStatusMetadata(db),
                  discordRealtime,
                  slackRealtime,
                  linkedInRealtime,
                  signalRealtime,
                  whatsAppRealtime,
                  autoSyncTargets: getAutoSyncTargets(db),
                  autoSyncIntervalMs: getAutoSyncIntervalMs(),
                  autoSyncIntervalsMs: Object.fromEntries(
                    getAutoSyncTargets(db).map((target) => [
                      `${target.platform}:${target.accountKey}`,
                      getAutoSyncIntervalMs(target.platform),
                    ]),
                  ),
                  signalCatchupIntervalMs: getAutoSyncIntervalMs("signal"),
                  whatsappCatchupIntervalMs: getAutoSyncIntervalMs("whatsapp"),
                  ingestConcurrency: getIngestConcurrency(),
                  projectionBatchSize: getProjectionBatchSize(),
                  realtimeProjectionEnabled: getRealtimeProjectionEnabled(),
                  realtimeProjectionBatchSize: getRealtimeProjectionBatchSize(),
                  deferredProjectionCoalesceMs: getDeferredProjectionCoalesceMs(),
                  bootstrap,
                }),
            ),
          };
        } catch (error) {
          if (!isSqliteBusyError(error)) {
            throw error;
          }
          return {
            id: request.id,
            ok: true,
            result: {
              ...buildDaemonBusyStatusSnapshot({
                discordRealtime,
                slackRealtime,
                linkedInRealtime,
                signalRealtime,
                whatsAppRealtime,
                socketPath: CUED_SOCKET_PATH,
                bootstrap,
                dbPath: db.dbPath,
                error,
              }),
              checks: [],
              warnings: [
                {
                  id: "daemon_db_busy",
                  severity: "warning",
                  message: "Cued database is busy; retry doctor after background work yields.",
                },
              ],
            },
          };
        }
      case "permissions-status":
        markInteractive();
        return {
          id: request.id,
          ok: true,
          result: await buildPermissionStatus(),
        };
      case "integrations-list": {
        markInteractive();
        const integrationAuthService = await getIntegrationAuthService();
        return {
          id: request.id,
          ok: true,
          result: integrationAuthService.listStatus(),
        };
      }
      case "integrations-refresh": {
        markInteractive();
        const integrationAuthService = await getIntegrationAuthService();
        await integrationAuthService.refresh();
        requestRealtimeReconcile();
        reconcileLocalWatchers();
        return {
          id: request.id,
          ok: true,
          result: integrationAuthService.listStatus(),
        };
      }
      case "integrations-connect": {
        markInteractive();
        const integrationAuthService = await getIntegrationAuthService();
        const started = await integrationAuthService.connectManaged(
          request.platform,
          request.accountKey,
          activeAuthSessions,
          {
            wakeIngest: schedulers.wakeIngest,
            onRuntimeStateChanged: requestRealtimeReconcile,
            emitAuthenticatedHook: async (platform, accountKey) => {
              await emitAuthenticatedHook(db, platform, accountKey);
            },
          },
        );
        return {
          id: request.id,
          ok: true,
          result: started,
        };
      }
      case "integrations-disconnect": {
        const integrationAuthService = await getIntegrationAuthService();
        const result = integrationAuthService.disconnect(request.platform, request.accountKey);
        requestRealtimeReconcile();
        reconcileLocalWatchers();
        return {
          id: request.id,
          ok: true,
          result,
        };
      }
      case "integrations-remove": {
        const integrationAuthService = await getIntegrationAuthService();
        const result = integrationAuthService.remove(request.platform, request.accountKey);
        requestRealtimeReconcile();
        reconcileLocalWatchers();
        return {
          id: request.id,
          ok: true,
          result,
        };
      }
      case "integrations-enable": {
        const integrationAuthService = await getIntegrationAuthService();
        const result = integrationAuthService.enable(request.platform, request.accountKey);
        requestRealtimeReconcile();
        reconcileLocalWatchers();
        return {
          id: request.id,
          ok: true,
          result,
        };
      }
      case "integrations-disable": {
        const integrationAuthService = await getIntegrationAuthService();
        const result = integrationAuthService.disable(request.platform, request.accountKey);
        requestRealtimeReconcile();
        reconcileLocalWatchers();
        return {
          id: request.id,
          ok: true,
          result,
        };
      }
      case "attachments-list":
        return {
          id: request.id,
          ok: true,
          result: listAttachments(db, {
            messageId: request.messageId,
            conversationId: request.conversationId,
            platform: request.platform,
            accountKey: request.accountKey,
            limit: request.limit,
          }),
        };
      case "attachment-fetch":
        return {
          id: request.id,
          ok: true,
          result: await fetchAttachment(db, {
            attachmentId: request.attachmentId,
            variant: request.variant,
            maxBytes: request.maxBytes,
            allowLarge: request.allowLarge,
            extractText: request.extractText,
            providerFetchers: {
              whatsapp: async (attachment) => {
                const accessRef = parseJsonRecord(attachment.access_ref_json);
                const chatJID = typeof accessRef?.chatJID === "string" ? accessRef.chatJID : null;
                const messageID =
                  typeof accessRef?.messageID === "string" ? accessRef.messageID : null;
                const attachmentIndex =
                  typeof accessRef?.attachmentIndex === "number" ? accessRef.attachmentIndex : 0;
                if (!chatJID || !messageID) {
                  throw new Error("WhatsApp attachment is missing provider fetch coordinates");
                }

                const session =
                  whatsAppRealtime.getSession(attachment.account_key) ??
                  (await whatsAppRealtime.waitForConnected(
                    attachment.account_key,
                    WHATSAPP_SEND_SESSION_WAIT_MS,
                  ));
                if (!session?.isConnected()) {
                  throw new Error(
                    `WhatsApp realtime session is not connected for '${attachment.account_key}'`,
                  );
                }

                const result = await session.downloadMedia(chatJID, messageID, attachmentIndex);
                return {
                  buffer: Buffer.from(result.dataBase64, "base64"),
                  mimeType: result.mimeType ?? attachment.mime_type,
                  filename: result.filename ?? attachment.filename,
                };
              },
            },
          }),
        };
      case "attachments-search":
        return {
          id: request.id,
          ok: true,
          result: searchAttachments(db, {
            query: request.query,
            platform: request.platform,
            accountKey: request.accountKey,
            conversationId: request.conversationId,
            limit: request.limit,
          }),
        };
      case "message-send":
        return {
          id: request.id,
          ok: true,
          result: runQueueService.queueMessageSend({
            platform: request.platform,
            target: request.target,
            text: request.text,
            accountKey: request.accountKey,
          }),
        };
      case "sync-run":
        return {
          id: request.id,
          ok: true,
          result: runQueueService.queueSyncRun(request.source),
        };
      case "sync-resume": {
        return {
          id: request.id,
          ok: true,
          result: runQueueService.queueSyncResume(buildSyncResumeTargets(db)),
        };
      }
      case "shutdown-for-update":
        return {
          id: request.id,
          ok: true,
          result: requestUpdateShutdown(),
        };
      case "contacts-merge":
        return {
          id: request.id,
          ok: true,
          result: runQueueService.mergeContacts({
            primaryContactId: request.primaryContactId,
            secondaryContactId: request.secondaryContactId,
            reason: request.reason,
          }),
        };
      case "contacts-merge-batch":
        return {
          id: request.id,
          ok: true,
          result: runQueueService.mergeContactsBatch({
            merges: request.merges,
            apply: request.apply,
          }),
        };
      case "rebuild":
        return {
          id: request.id,
          ok: true,
          result: runQueueService.queueRebuild(),
        };
      case "reset":
        return {
          id: request.id,
          ok: true,
          result: runQueueService.resetSource(request.source),
        };
      default:
        return {
          id: request satisfies never,
          ok: false,
          error: "Unsupported command",
        };
    }
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
