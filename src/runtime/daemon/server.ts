import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, type FSWatcher, rmSync, watch } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { basename, dirname } from "node:path";
import process from "node:process";
import { getCurrentAppVersion, getCurrentReleaseChannel } from "../../core/app-metadata.js";
import { CUED_DAEMON_LOCK_PATH, CUED_SOCKET_PATH } from "../../core/config.js";
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
import { safeParseJsonRecord } from "../../db/codecs.js";
import { type OutboundMessageRow, openCuedDatabase } from "../../db/database.js";
import { isAdapterPlatform, listAutoSyncPlatforms } from "../../platforms/core/registry.js";
import { runAdapter } from "../../platforms/core/runner.js";
import { loadIntegrationSecret } from "../../platforms/core/secrets/keychain.js";
import { refreshLocalIntegrationStates } from "../../platforms/core/state/local-refresh.js";
import { refreshManagedIntegrationStates } from "../../platforms/core/state/refresh.js";
import { getIntegrationSummary } from "../../platforms/core/state/status.js";
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
import { isSlackBackfillConversationProof } from "../../platforms/slack/sync/proof.js";
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
import type {
  WhatsAppHelperEventEnvelope,
  WhatsAppReceiptSnapshot,
  WhatsAppSnapshot,
} from "../../platforms/whatsapp/types.js";
import { fetchAttachment, listAttachments, searchAttachments } from "../attachments.js";
import { emitHookEvent } from "../hooks.js";
import type { DaemonRequest, DaemonResponse } from "../ipc.js";
import { collectInboundMessageHookPayloads } from "../message-hooks.js";
import { resolveMacOSNativeBinary } from "../native-binary.js";
import {
  projectDeferredRange,
  projectPendingRawEvents,
  projectRealtimeRange,
  rebuildProjectedState,
} from "../projection/projector.js";
import {
  buildProjectionMessageHookBatches,
  mergeProjectionRunDetails,
  ProjectionMessageHookBarrier,
  type ProjectionMessageHookPayload,
  type ProjectionRunDetails,
  parseProjectionRunDetails,
} from "../projection/service.js";
import { RunQueueService } from "../run-queue.js";
import {
  buildDaemonStatusSnapshot,
  buildDoctorSnapshot,
  type DaemonBootstrapSnapshot,
} from "../status.js";
import { checkForUpdates } from "../updater/service.js";
import {
  shouldBootstrapLocalIntegrations,
  shouldRunLocalWatcher as shouldRunLocalWatcherForState,
} from "./local-watchers.js";

const DAEMON_VERSION = getCurrentAppVersion();
const DEFAULT_AUTOSYNC_INTERVAL_MS = 60_000;
const DEFAULT_SIGNAL_CATCHUP_INTERVAL_MS = 300_000;
const DEFAULT_WHATSAPP_CATCHUP_INTERVAL_MS = 300_000;
const DEFAULT_SLACK_REALTIME_ENABLED = false;
const DEFAULT_INGEST_CONCURRENCY = 4;
const DEFAULT_PROJECTION_BATCH_SIZE = 1_000;
const DEFAULT_REALTIME_PROJECTION_ENABLED = true;
const DEFAULT_DEFERRED_PROJECTION_COALESCE_MS = 250;
const NATIVE_WATCH_DEBOUNCE_MS = 1_500;
const AUTOSYNC_SCHEDULER_TICK_MS = 1_000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_SHUTDOWN_GRACE_MS = 30_000;
const SIGNAL_SEND_SESSION_WAIT_MS = 3_000;
const SIGNAL_SEND_ECHO_TIMEOUT_MS = 5_000;
const WHATSAPP_SEND_SESSION_WAIT_MS = 3_000;
const daemonLogger = createLogger("daemon");
const hooksLogger = createLogger("hooks");
const nativeWatchLogger = createLogger("native-watch");
const linkedInLogger = createLogger("linkedin");
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
  wakeIngest: () => void;
  wakeOutbound: () => void;
  wakeProjection: () => void;
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

function getAutoSyncTargets(
  db: ReturnType<typeof openCuedDatabase>,
): Array<{ platform: AdapterPlatform; accountKey: string }> {
  const configured = process.env.CUED_AUTOSYNC_PLATFORMS?.split(",")
    .map((value) => value.trim())
    .filter(isAdapterPlatform);

  if (configured && configured.length > 0) {
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

  return DEFAULT_AUTOSYNC_INTERVAL_MS;
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

function getRealtimeProjectionBatchSize(): number {
  const configured = Number(
    process.env.CUED_REALTIME_PROJECTION_BATCH_SIZE ?? getProjectionBatchSize(),
  );
  return Number.isFinite(configured) && configured > 0 ? configured : getProjectionBatchSize();
}

function getDeferredProjectionCoalesceMs(): number {
  const configured = Number(
    process.env.CUED_DEFERRED_PROJECTION_COALESCE_MS ?? DEFAULT_DEFERRED_PROJECTION_COALESCE_MS,
  );
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_DEFERRED_PROJECTION_COALESCE_MS;
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
  const activeAuthSessions = new Map<
    string,
    { child: ChildProcess; platform: Platform; accountKey: string }
  >();
  const activeIngestRuns = new Map<string, Promise<void>>();
  let activeOutboundSend: Promise<void> | null = null;
  let isProcessingProjection = false;
  let ingestDrainScheduled = false;
  let outboundDrainScheduled = false;
  let projectionDrainScheduled = false;
  let projectionDrainTimer: NodeJS.Timeout | null = null;
  const lastAutoSyncQueuedAt = new Map<string, number>();
  const pendingSignalSendEchoes = new Map<string, PendingSignalEcho[]>();
  const projectionMessageHooks = new ProjectionMessageHookBarrier();
  const suppressNextSignalReconnectSync = new Set<string>();
  const nativeWatchers = new Map<"contacts" | "imessage", FSWatcher | ChildProcess>();
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

  const drainIngestQueue = () => {
    ingestDrainScheduled = false;
    if (isUpdateShutdownRequested) {
      return;
    }
    while (activeIngestRuns.size < ingestConcurrency) {
      const currentRun = db.claimNextQueuedRun(["sync", "sync_resume"], "ingesting");
      if (!currentRun) {
        break;
      }

      const promise = processIngestRun(currentRun).finally(() => {
        activeIngestRuns.delete(currentRun.id);
        scheduleIngestDrain();
        maybeFinishUpdateShutdown();
      });
      activeIngestRuns.set(currentRun.id, promise);
    }
  };

  const scheduleIngestDrain = () => {
    if (ingestDrainScheduled) {
      return;
    }
    ingestDrainScheduled = true;
    setImmediate(drainIngestQueue);
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
        const logger = message.platform === "signal" ? signalLogger : whatsAppLogger;
        logger.warn("outbound send failed", {
          accountKey: message.account_key,
          outboundMessageId: message.id,
          error: messageText,
        });
        db.failOutboundMessage({
          id: message.id,
          retryable: message.platform === "signal" ? isRetryableSignalSendError(messageText) : true,
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
    if (isUpdateShutdownRequested) {
      return;
    }
    if (isProcessingProjection) {
      return;
    }

    const currentRun = db.claimNextQueuedRun(["project", "rebuild"], "projecting");
    if (!currentRun) {
      return;
    }

    isProcessingProjection = true;
    void processProjectionRun(currentRun);
  };

  const scheduleProjectionDrain = (delayMs = 0) => {
    if (projectionDrainScheduled) {
      return;
    }
    projectionDrainScheduled = true;
    if (delayMs <= 0) {
      setImmediate(drainProjectionQueue);
      return;
    }

    projectionDrainTimer = setTimeout(() => {
      projectionDrainTimer = null;
      drainProjectionQueue();
    }, delayMs);
  };

  const schedulers = {
    wakeIngest: scheduleIngestDrain,
    wakeOutbound: scheduleOutboundDrain,
    wakeProjection: () => scheduleProjectionDrain(),
  };
  const queueDebouncedNativeSync = createDebouncedSyncEnqueuer(db, schedulers.wakeIngest);
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

    const desiredPlatforms = (["imessage", "contacts"] as const).filter((platform) =>
      shouldStartLocalWatcher(platform),
    );

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

  const requestSlackRealtimeReconcile = () => {
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
      db.upsertDaemonState({
        pid: process.pid,
        startedAt,
        updatedAt: now(),
        status: "running",
        version: DAEMON_VERSION,
        details: daemonIdentity,
      });
    } catch (error) {
      if (!isSqliteBusyError(error)) {
        throw error;
      }
      daemonLogger.warn("heartbeat skipped because SQLite is busy");
    }
  }, SINGLETON_LOCK_HEARTBEAT_MS);

  const queueAutoSyncRuns = (trigger: string) => {
    if (isUpdateShutdownRequested) {
      return;
    }
    try {
      const autoSyncTargets = getAutoSyncTargets(db);
      let queuedAny = false;
      const queuedAt = now();
      for (const target of autoSyncTargets) {
        if (trigger === "scheduler") {
          if (bootstrap.state !== "ready") {
            continue;
          }
          const targetKey = `${target.platform}:${target.accountKey}`;
          const lastQueuedAt = lastAutoSyncQueuedAt.get(targetKey) ?? startedAt;
          if (queuedAt - lastQueuedAt < getAutoSyncIntervalMs(target.platform)) {
            continue;
          }
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
    const backlog = db.getProjectionBacklog();
    const incomingDetails = mergeProjectionRunDetails({
      existing: null,
      incoming: {
        trigger,
        startRowId: range?.startRowId ?? backlog.projection_watermark + 1,
        endRowId: range?.endRowId ?? backlog.max_raw_event_rowid,
        projectionWatermark: backlog.projection_watermark,
        maxRawEventRowid: backlog.max_raw_event_rowid,
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
        db.updateRunDetails(queuedProjectionRun.id, mergedDetails satisfies ProjectionRunDetails);
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
      details: incomingDetails satisfies ProjectionRunDetails,
    });
    scheduleProjectionDrain(options?.delayMs ?? deferredProjectionCoalesceMs);
    return runId;
  };
  scheduleOutboundDrain();

  const stopRealtimeAndWatchers = () => {
    for (const watcher of nativeWatchers.values()) {
      stopNativeWatcher(watcher);
    }
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
      const envOverrides: Record<string, string> = {};
      if (platform === "imessage" && typeof sourceCursor?.rowId === "number") {
        envOverrides.CUED_IMESSAGE_LAST_ROWID = String(sourceCursor.rowId);
      }
      if (platform === "slack" && typeof sourceCursor?.lastSyncAt === "number") {
        envOverrides.CUED_SLACK_LAST_SYNC_AT = String(sourceCursor.lastSyncAt);
      }
      if (platform === "slack" && checkpoint?.source_cursor_json) {
        envOverrides.CUED_SLACK_SOURCE_CURSOR = checkpoint.source_cursor_json;
      }
      if (platform === "linkedin") {
        if (checkpoint?.source_cursor_json) {
          envOverrides.CUED_LINKEDIN_SOURCE_CURSOR = checkpoint.source_cursor_json;
        }
        if (typeof sourceCursor?.lastSyncAt === "number") {
          envOverrides.CUED_LINKEDIN_LAST_SYNC_AT = String(sourceCursor.lastSyncAt);
        }
        if (typeof sourceCursor?.syncToken === "string" && sourceCursor.syncToken.length > 0) {
          envOverrides.CUED_LINKEDIN_SYNC_TOKEN = sourceCursor.syncToken;
        }
      }
      if (platform === "signal" && typeof sourceCursor?.lastSyncAt === "number") {
        envOverrides.CUED_SIGNAL_LAST_SYNC_AT = String(sourceCursor.lastSyncAt);
      }

      const adapterStartedAt = now();
      let adapterFetchMs = 0;
      let rawEventInsertMs = 0;
      let ingestedCount = 0;
      let bundleHasMore = false;
      let bundleSyncMode: "full" | "incremental" = checkpoint?.source_cursor_json
        ? "incremental"
        : "full";
      let bundleSourceCursor: Record<string, unknown> | null = null;
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
        bundleSyncMode = checkpoint?.source_cursor_json ? "incremental" : "full";

        let cursor: string | null = null;
        let hasMore = false;
        let lastCompletedAt = now();
        do {
          const pageFetchStartedAt = now();
          const page = await session.resync({
            cursor,
            sinceMs:
              bundleSyncMode === "incremental" ? (checkpoint?.last_success_at ?? null) : null,
            limit: 1000,
          });
          adapterFetchMs += now() - pageFetchStartedAt;

          const rawEvents = withRawEventAcquisitionMode(
            buildWhatsAppRawEventsFromSnapshot({
              accountKey,
              snapshot: page,
            }),
            "sync",
          );
          ingestedCount += rawEvents.length;
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
        } while (hasMore);

        bundleHasMore = false;
        bundleSourceCursor = {
          lastSyncAt: lastCompletedAt,
        };
        checkpointLastSuccessAt = lastCompletedAt;
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
        ingestedCount = bundle.rawEvents.length;
        const rawEventInsertStartedAt = now();
        insertResult = db.insertRawEvents(withRawEventAcquisitionMode(bundle.rawEvents, "sync"));
        rawEventInsertMs = now() - rawEventInsertStartedAt;
        const slackBackfillDiagnostics = Array.isArray(
          bundle.diagnostics?.slackBackfillConversations,
        )
          ? bundle.diagnostics.slackBackfillConversations
          : [];
        const bundleProofs = Array.isArray(bundle.proofs) ? bundle.proofs : [];
        for (const proof of bundleProofs) {
          db.upsertSyncProof({
            platform,
            accountKey,
            proof,
          });
        }
        if (platform === "slack") {
          for (const proof of slackBackfillDiagnostics) {
            if (isSlackBackfillConversationProof(proof)) {
              db.upsertSlackBackfillProof(proof);
            }
          }
        }
        checkpointLastSuccessAt = now();
      }

      db.upsertSourceAccounts(sourceAccounts);
      const realtimeProjectionStartedAt = now();
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
        queueProjectionRun(`ingest:${currentRun.platform}:${accountKey}`, undefined, {
          delayMs: deferredProjectionCoalesceMs,
        });
        projectionQueued = true;
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
      });
      if (platform === "signal") {
        requestSignalRealtimeReconcile();
      }
      if (bundleHasMore && !db.hasQueuedOrRunningRun(currentRun.platform, accountKey)) {
        db.queueSyncRun({
          platform: currentRun.platform,
          accountKey,
          runType: "sync_resume",
          trigger: "ingest_continue",
          details: {
            source: currentRun.platform,
            accountKey,
            trigger: "ingest_continue",
          },
        });
        schedulers.wakeIngest();
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
        totalMs: timings.totalMs,
      });
    } catch (error) {
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
    const projectionStartedAt = now();
    daemonLogger.info("projection run started", {
      runId: currentRun.id,
      trigger: currentRun.trigger,
      runType: currentRun.run_type,
    });
    try {
      const projectionDetails = parseProjectionRunDetails(currentRun.details_json);
      const projected =
        currentRun.run_type === "rebuild"
          ? rebuildProjectedState(db)
          : projectionDetails
            ? projectDeferredRange(db, {
                startRowId: projectionDetails.startRowId,
                endRowId: projectionDetails.endRowId,
                limit: projectionBatchSize,
              })
            : (() => {
                const backlog = db.getProjectionBacklog();
                return backlog.pending_raw_events === 0
                  ? projectPendingRawEvents(db, { limit: projectionBatchSize })
                  : projectDeferredRange(db, {
                      startRowId: backlog.projection_watermark + 1,
                      endRowId: backlog.max_raw_event_rowid,
                      limit: projectionBatchSize,
                    });
              })();
      const projectionFinishedAt = now();
      const timings = {
        projectionMs: projectionFinishedAt - projectionStartedAt,
        totalMs: projectionFinishedAt - projectionStartedAt,
      };
      const deferredProjected =
        currentRun.run_type === "project"
          ? (projected as ReturnType<typeof projectDeferredRange>)
          : null;
      db.finishRun(currentRun.id, {
        projected,
        timings,
        range: projectionDetails,
      });
      if (currentRun.run_type === "rebuild") {
        await projectionMessageHooks.releaseAll(async (payload) => {
          await safeEmitHookEvent("message.received", payload);
        });
      }
      const projectedRangeStart =
        deferredProjected?.rangeStartRowId ?? projectionDetails?.startRowId ?? null;
      const projectedRangeEnd =
        deferredProjected == null
          ? null
          : deferredProjected.nextStartRowId != null
            ? deferredProjected.nextStartRowId - 1
            : (deferredProjected.rangeEndRowId ?? projectionDetails?.endRowId ?? null);
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
          { delayMs: 0 },
        );
      }
      queueProjectionRun(`projection:${currentRun.run_type}`, undefined, { delayMs: 0 });
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
      daemonLogger.error("projection run failed", {
        runId: currentRun.id,
        runType: currentRun.run_type,
        error: error instanceof Error ? error.message : String(error),
      });
      db.failRun(currentRun.id, error instanceof Error ? error.message : String(error));
      await safeEmitHookEvent("sync.failed", {
        runId: currentRun.id,
        platform: currentRun.platform,
        runType: currentRun.run_type,
        stage: "projection",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      isProcessingProjection = false;
      schedulers.wakeProjection();
      maybeFinishUpdateShutdown();
    }
  };

  const schedulerLoop = setInterval(() => {
    queueAutoSyncRuns("scheduler");
  }, AUTOSYNC_SCHEDULER_TICK_MS);

  const updateLoop = setInterval(() => {
    scheduleUpdateCheck(false);
  }, UPDATE_CHECK_INTERVAL_MS);

  const server = createServer((socket) => {
    handleSocket(
      socket,
      db,
      activeAuthSessions,
      schedulers,
      slackRealtime,
      linkedInRealtime,
      signalRealtime,
      whatsAppRealtime,
      bootstrap,
      () => {
        requestSlackRealtimeReconcile();
        requestLinkedInRealtimeReconcile();
        requestSignalRealtimeReconcile();
        requestWhatsAppRealtimeReconcile();
      },
      reconcileLocalWatchers,
      requestUpdateShutdown,
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
    clearInterval(schedulerLoop);
    clearInterval(updateLoop);
    if (projectionDrainTimer) {
      clearTimeout(projectionDrainTimer);
      projectionDrainTimer = null;
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

function writeResponse(socket: Socket, response: DaemonResponse): void {
  socket.write(`${JSON.stringify(response)}\n`);
}

function handleSocket(
  socket: Socket,
  db: ReturnType<typeof openCuedDatabase>,
  activeAuthSessions: Map<string, { child: ChildProcess; platform: Platform; accountKey: string }>,
  schedulers: QueueSchedulers,
  slackRealtime: SlackRealtimeSupervisor,
  linkedInRealtime: LinkedInRealtimeSupervisor,
  signalRealtime: SignalRealtimeSupervisor,
  whatsAppRealtime: WhatsAppRealtimeSupervisor,
  bootstrap: DaemonBootstrapSnapshot,
  requestRealtimeReconcile: () => void,
  reconcileLocalWatchers: () => void,
  requestUpdateShutdown: () => { shuttingDown: boolean; requestedAt: number | null },
): void {
  let buffer = "";

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
          slackRealtime,
          linkedInRealtime,
          signalRealtime,
          whatsAppRealtime,
          bootstrap,
          requestRealtimeReconcile,
          reconcileLocalWatchers,
          requestUpdateShutdown,
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
  slackRealtime: SlackRealtimeSupervisor,
  linkedInRealtime: LinkedInRealtimeSupervisor,
  signalRealtime: SignalRealtimeSupervisor,
  whatsAppRealtime: WhatsAppRealtimeSupervisor,
  bootstrap: DaemonBootstrapSnapshot,
  requestRealtimeReconcile: () => void,
  reconcileLocalWatchers: () => void,
  requestUpdateShutdown: () => { shuttingDown: boolean; requestedAt: number | null },
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
        return {
          id: request.id,
          ok: true,
          result: buildDaemonStatusSnapshot(db, {
            app: getAppStatusMetadata(db),
            slackRealtime,
            linkedInRealtime,
            signalRealtime,
            whatsAppRealtime,
            socketPath: CUED_SOCKET_PATH,
            bootstrap,
          }),
        };
      case "doctor":
        return {
          id: request.id,
          ok: true,
          result: await buildDoctorSnapshot(db, {
            app: getAppStatusMetadata(db),
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
        };
      case "integrations-list": {
        const integrationAuthService = await getIntegrationAuthService();
        return {
          id: request.id,
          ok: true,
          result: integrationAuthService.listStatus(),
        };
      }
      case "integrations-refresh": {
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
        const targets = [
          ...getAutoSyncTargets(db).map((target) => `${target.platform}:${target.accountKey}`),
          ...db
            .listCheckpointTargets()
            .filter((target) => isAdapterPlatform(target.platform))
            .map((target) => `${target.platform}:${target.account_key}`),
        ];
        return {
          id: request.id,
          ok: true,
          result: runQueueService.queueSyncResume(
            targets.flatMap((targetKey) => {
              const [platform, accountKey] = targetKey.split(":");
              return platform && accountKey && isAdapterPlatform(platform)
                ? [{ platform, accountKey }]
                : [];
            }),
          ),
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
