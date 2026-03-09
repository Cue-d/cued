import { createServer, type Socket } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync, watch, type FSWatcher } from "node:fs";
import { dirname, basename } from "node:path";
import process from "node:process";
import { CUED_SOCKET_PATH } from "../config.js";
import { openCuedDatabase } from "../db/database.js";
import { buildDoctorReport } from "../diagnostics/doctor.js";
import type { DaemonRequest, DaemonResponse } from "../ipc/protocol.js";
import { runAdapter } from "../adapters/runner.js";
import { isAdapterPlatform, listAutoSyncPlatforms } from "../adapters/registry.js";
import {
  buildIntegrationStatus,
  completeAuthSession,
  connectIntegration,
  disconnectIntegration,
  getAuthSessionSummary,
  getIntegrationSummary,
  listAuthSessions,
  listIntegrationStates,
  markAuthSessionInProgress,
  refreshManagedIntegrationStates,
  setIntegrationEnabled,
} from "../integrations/service.js";
import { startAuthSession } from "../integrations/auth-runtime.js";
import { doctorHooksConfig, emitHookEvent } from "../hooks/service.js";
import { projectPendingRawEvents, rebuildProjectedState } from "../projector/projector.js";
import { DEFAULT_CHAT_DB_PATH } from "../adapters/imessage/reader.js";
import { resolveMacOSNativeBinary } from "../workers/native-binary.js";
import {
  getDefaultAccountKeyForPlatform,
  isPlatform,
  type AdapterPlatform,
  type Platform,
} from "../types/provider.js";

const DAEMON_VERSION = "0.1.0";
const DEFAULT_AUTOSYNC_INTERVAL_MS = 60_000;
const DEFAULT_INGEST_CONCURRENCY = 4;
const DEFAULT_PROJECTION_BATCH_SIZE = 1_000;
const NATIVE_WATCH_DEBOUNCE_MS = 1_500;

function now(): number {
  return Date.now();
}

function getAutoSyncTargets(
  db: ReturnType<typeof openCuedDatabase>,
): Array<{ platform: AdapterPlatform; accountKey: string }> {
  const configured = process.env.CUED_AUTOSYNC_PLATFORMS
    ?.split(",")
    .map((value) => value.trim())
    .filter(isAdapterPlatform);

  if (configured && configured.length > 0) {
    return configured.map((platform) => ({
      platform,
      accountKey: getDefaultAccountKeyForPlatform(platform),
    }));
  }

  const enabled = db.listEnabledSyncTargets()
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

function getAutoSyncIntervalMs(): number {
  const configured = Number(process.env.CUED_AUTOSYNC_INTERVAL_MS ?? DEFAULT_AUTOSYNC_INTERVAL_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_AUTOSYNC_INTERVAL_MS;
}

function getIngestConcurrency(): number {
  const configured = Number(process.env.CUED_INGEST_CONCURRENCY ?? DEFAULT_INGEST_CONCURRENCY);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_INGEST_CONCURRENCY;
}

function getProjectionBatchSize(): number {
  const configured = Number(process.env.CUED_PROJECTION_BATCH_SIZE ?? DEFAULT_PROJECTION_BATCH_SIZE);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_PROJECTION_BATCH_SIZE;
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

async function safeEmitHookEvent(
  event: "integration.authenticated" | "sync.completed" | "sync.failed" | "message.received",
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await emitHookEvent(event, payload);
  } catch (error) {
    console.warn(
      `[cued hooks] ${event} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function emitAuthenticatedHook(
  db: ReturnType<typeof openCuedDatabase>,
  platform: string,
  accountKey: string,
  sessionId: string,
): Promise<void> {
  await safeEmitHookEvent("integration.authenticated", {
    integration: getIntegrationSummary(db, platform, accountKey),
    authSession: getAuthSessionSummary(db, sessionId),
  });
}

function queueNativeTriggeredSync(
  db: ReturnType<typeof openCuedDatabase>,
  platform: AdapterPlatform,
  accountKey: string,
  trigger: string,
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
}

function createDebouncedSyncEnqueuer(
  db: ReturnType<typeof openCuedDatabase>,
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
      queueNativeTriggeredSync(db, platform, accountKey, trigger);
    }, NATIVE_WATCH_DEBOUNCE_MS);
    timers.set(key, timer);
  };
}

function startIMessageWatcher(
  db: ReturnType<typeof openCuedDatabase>,
  queueSync: (platform: AdapterPlatform, accountKey: string, trigger: string) => void,
): FSWatcher | null {
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
    console.warn(
      `[cued native-watch] imessage watcher unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function startContactsWatcher(
  db: ReturnType<typeof openCuedDatabase>,
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
      console.warn(`[cued native-watch] contacts watcher: ${message}`);
    }
  });

  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.warn(`[cued native-watch] contacts watcher exited with code ${code}`);
    }
  });

  return child;
}

function isInboundMessageEvent(rawEvent: Record<string, unknown>): boolean {
  return rawEvent.entityKind === "message"
    && rawEvent.eventKind === "message_created"
    && typeof rawEvent.payload === "object"
    && rawEvent.payload !== null
    && typeof (rawEvent.payload as Record<string, unknown>).senderSourceKey === "string"
    && ((rawEvent.payload as Record<string, unknown>).senderSourceKey as string).length > 0;
}

async function startManagedAuth(
  db: ReturnType<typeof openCuedDatabase>,
  platform: string,
  accountKey: string | undefined,
  activeAuthSessions: Map<string, { child: ChildProcess; platform: Platform; accountKey: string }>,
): Promise<{
  integration: ReturnType<typeof getIntegrationSummary>;
  authSession: ReturnType<typeof getAuthSessionSummary>;
}> {
  const requested = connectIntegration(db, platform, accountKey);
  const integration = getIntegrationSummary(
    db,
    requested.integration.platform,
    requested.integration.accountKey,
  );
  const runtime = startAuthSession(db, requested.authSession, integration);
  const running = markAuthSessionInProgress(
    db,
    requested.authSession.id,
    runtime.child.pid ?? process.pid,
  );
  activeAuthSessions.set(running.id, {
    child: runtime.child,
    platform: running.platform,
    accountKey: running.accountKey,
  });

  runtime.completion
    .then(async (result) => {
      const completed = completeAuthSession(db, running.id, {
        state: result.state,
        keychainService: result.keychainService ?? null,
        keychainAccount: result.keychainAccount ?? null,
        resultSummary: result.resultSummary ?? null,
        errorSummary: result.errorSummary ?? null,
      });
      if (completed.integration.authState === "authenticated") {
        await emitAuthenticatedHook(db, completed.integration.platform, completed.integration.accountKey, running.id);
      }
    })
    .catch((error) => {
      const latest = db.getAuthSession(running.id);
      if (latest?.state === "cancelled") {
        return;
      }
      completeAuthSession(db, running.id, {
        state: "failed",
        errorSummary: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      activeAuthSessions.delete(running.id);
    });

  return {
    integration: getIntegrationSummary(db, requested.integration.platform, requested.integration.accountKey),
    authSession: getAuthSessionSummary(db, running.id),
  };
}

export async function runDaemon(): Promise<void> {
  const db = openCuedDatabase();
  const startedAt = now();
  const autoSyncIntervalMs = getAutoSyncIntervalMs();
  const ingestConcurrency = getIngestConcurrency();
  const projectionBatchSize = getProjectionBatchSize();
  const activeAuthSessions = new Map<
    string,
    { child: ChildProcess; platform: Platform; accountKey: string }
  >();
  const activeIngestRuns = new Map<string, Promise<void>>();
  let isProcessingProjection = false;
  const queueDebouncedNativeSync = createDebouncedSyncEnqueuer(db);

  db.failInProgressRuns("Recovered stale in-progress sync after daemon restart");
  await refreshManagedIntegrationStates(db);

  if (existsSync(CUED_SOCKET_PATH)) {
    rmSync(CUED_SOCKET_PATH, { force: true });
  }

  db.upsertDaemonState({
    pid: process.pid,
    startedAt,
    updatedAt: startedAt,
    status: "running",
    version: DAEMON_VERSION,
  });

  const heartbeat = setInterval(() => {
    db.upsertDaemonState({
      pid: process.pid,
      startedAt,
      updatedAt: now(),
      status: "running",
      version: DAEMON_VERSION,
    });
  }, 5_000);

  const queueAutoSyncRuns = (trigger: string) => {
    const autoSyncTargets = getAutoSyncTargets(db);
    for (const target of autoSyncTargets) {
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
    }
  };

  const queueProjectionRun = (trigger: string) => {
    const backlog = db.getProjectionBacklog();
    if (backlog.pending_raw_events === 0 || db.hasQueuedOrActiveProjectionRun()) {
      return null;
    }

    return db.queueSyncRun({
      runType: "project",
      trigger,
      details: {
        trigger,
        projectionWatermark: backlog.projection_watermark,
        maxRawEventRowid: backlog.max_raw_event_rowid,
      },
    });
  };

  queueAutoSyncRuns("daemon_start");
  queueProjectionRun("daemon_start");

  const nativeWatchers: Array<FSWatcher | ChildProcess> = [];
  if (process.platform === "darwin") {
    const imessageWatcher = startIMessageWatcher(db, queueDebouncedNativeSync);
    if (imessageWatcher) {
      nativeWatchers.push(imessageWatcher);
    }

    const contactsWatcher = startContactsWatcher(db, queueDebouncedNativeSync);
    if (contactsWatcher) {
      nativeWatchers.push(contactsWatcher);
    }
  }

  const processIngestRun = async (
    currentRun: NonNullable<ReturnType<typeof db.claimNextQueuedRun>>,
  ) => {
    try {
      if (
        (currentRun.run_type !== "sync" && currentRun.run_type !== "sync_resume")
        || !currentRun.platform
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

      const accountKey = currentRun.account_key ?? getDefaultAccountKeyForPlatform(currentRun.platform);
      const checkpoint = db.getCheckpoint(currentRun.platform, accountKey);
      const sourceCursor = checkpoint?.source_cursor_json
        ? (JSON.parse(checkpoint.source_cursor_json) as Record<string, unknown>)
        : null;
      const envOverrides: Record<string, string> = {};
      if (currentRun.platform === "imessage" && typeof sourceCursor?.rowId === "number") {
        envOverrides.CUED_IMESSAGE_LAST_ROWID = String(sourceCursor.rowId);
      }
      if (currentRun.platform === "slack" && typeof sourceCursor?.lastSyncAt === "number") {
        envOverrides.CUED_SLACK_LAST_SYNC_AT = String(sourceCursor.lastSyncAt);
      }
      if (currentRun.platform === "linkedin") {
        if (typeof sourceCursor?.lastSyncAt === "number") {
          envOverrides.CUED_LINKEDIN_LAST_SYNC_AT = String(sourceCursor.lastSyncAt);
        }
        if (typeof sourceCursor?.syncToken === "string" && sourceCursor.syncToken.length > 0) {
          envOverrides.CUED_LINKEDIN_SYNC_TOKEN = sourceCursor.syncToken;
        }
      }

      const bundle = await runAdapter(currentRun.platform, accountKey, envOverrides);
      const inboundMessages: Array<Record<string, unknown>> = [];
      let insertedRawEvents = 0;
      for (const account of bundle.sourceAccounts) {
        db.upsertSourceAccount(account);
      }
      for (const rawEvent of bundle.rawEvents) {
        const inserted = db.insertRawEvent(rawEvent);
        if (!inserted) {
          continue;
        }
        insertedRawEvents += 1;
        if (isInboundMessageEvent({ ...rawEvent, payload: rawEvent.payload as Record<string, unknown> })) {
          inboundMessages.push({
            platform: rawEvent.platform,
            accountKey: rawEvent.accountKey,
            observedAt: rawEvent.observedAt,
            payload: rawEvent.payload,
          });
        }
      }

      const projection = db.getProjectionBacklog();
      const checkpointSyncMode = resolveCheckpointSyncMode(
        currentRun.run_type,
        checkpoint?.sync_mode,
        bundle.syncMode,
        bundle.hasMore ?? false,
      );
      db.upsertCheckpoint({
        platform: currentRun.platform,
        accountKey,
        syncMode: checkpointSyncMode,
        sourceCursor: bundle.sourceCursor,
        rawIngestWatermark: projection.max_raw_event_rowid,
        projectionWatermark: projection.projection_watermark,
        lastSuccessAt: now(),
      });

      if (insertedRawEvents > 0) {
        queueProjectionRun(`ingest:${currentRun.platform}:${accountKey}`);
      }
      db.finishRun(currentRun.id, {
        ingested: bundle.rawEvents.length,
        insertedRawEvents,
        projectionQueued: insertedRawEvents > 0,
        hasMore: bundle.hasMore ?? false,
        syncMode: checkpointSyncMode,
      });
      if (bundle.hasMore && !db.hasQueuedOrRunningRun(currentRun.platform, accountKey)) {
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
      }
      await safeEmitHookEvent("sync.completed", {
        runId: currentRun.id,
        platform: currentRun.platform,
        accountKey,
        runType: currentRun.run_type,
        stage: "ingest",
        ingested: bundle.rawEvents.length,
        insertedRawEvents,
      });
      for (const message of inboundMessages) {
        await safeEmitHookEvent("message.received", {
          runId: currentRun.id,
          message,
        });
      }
    } catch (error) {
      db.failRun(currentRun.id, error instanceof Error ? error.message : String(error));
      await safeEmitHookEvent("sync.failed", {
        runId: currentRun.id,
        platform: currentRun.platform,
        runType: currentRun.run_type,
        stage: "ingest",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const processProjectionRun = async (
    currentRun: NonNullable<ReturnType<typeof db.claimNextQueuedRun>>,
  ) => {
    try {
      const projected = currentRun.run_type === "rebuild"
        ? rebuildProjectedState(db)
        : projectPendingRawEvents(db, { limit: projectionBatchSize });
      db.finishRun(currentRun.id, { projected });
      queueProjectionRun(`projection:${currentRun.run_type}`);
      await safeEmitHookEvent("sync.completed", {
        runId: currentRun.id,
        platform: currentRun.platform,
        runType: currentRun.run_type,
        stage: "projection",
        projected,
      });
    } catch (error) {
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
    }
  };

  const ingestLoop = setInterval(() => {
    while (activeIngestRuns.size < ingestConcurrency) {
      const currentRun = db.claimNextQueuedRun(["sync", "sync_resume"], "ingesting");
      if (!currentRun) {
        break;
      }

      const promise = processIngestRun(currentRun)
        .finally(() => {
          activeIngestRuns.delete(currentRun.id);
        });
      activeIngestRuns.set(currentRun.id, promise);
    }
  }, 250);

  const projectionLoop = setInterval(() => {
    if (isProcessingProjection) {
      return;
    }

    const currentRun = db.claimNextQueuedRun(["project", "rebuild"], "projecting");
    if (!currentRun) {
      return;
    }

    isProcessingProjection = true;
    void processProjectionRun(currentRun);
  }, 250);

  const schedulerLoop = setInterval(() => {
    queueAutoSyncRuns("scheduler");
  }, autoSyncIntervalMs);

  const server = createServer((socket) => {
    handleSocket(socket, db, activeAuthSessions);
  });

  server.listen(CUED_SOCKET_PATH);

  const shutdown = () => {
    clearInterval(heartbeat);
    clearInterval(ingestLoop);
    clearInterval(projectionLoop);
    clearInterval(schedulerLoop);
    for (const watcher of nativeWatchers) {
      if ("close" in watcher && typeof watcher.close === "function") {
        watcher.close();
        continue;
      }
      if ("kill" in watcher && typeof watcher.kill === "function") {
        watcher.kill("SIGTERM");
      }
    }
    db.upsertDaemonState({
      pid: null,
      startedAt,
      updatedAt: now(),
      status: "stopped",
      version: DAEMON_VERSION,
    });
    server.close();
    db.close();
    if (existsSync(CUED_SOCKET_PATH)) {
      rmSync(CUED_SOCKET_PATH, { force: true });
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function writeResponse(socket: Socket, response: DaemonResponse): void {
  socket.write(`${JSON.stringify(response)}\n`);
}

function handleSocket(
  socket: Socket,
  db: ReturnType<typeof openCuedDatabase>,
  activeAuthSessions: Map<
    string,
    { child: ChildProcess; platform: Platform; accountKey: string }
  >,
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

        void dispatchRequest(db, request, activeAuthSessions)
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
  activeAuthSessions: Map<
    string,
    { child: ChildProcess; platform: Platform; accountKey: string }
  >,
): Promise<DaemonResponse> {
  try {
    switch (request.command) {
      case "ping":
        return { id: request.id, ok: true, result: { pong: true } };
      case "status":
        return {
          id: request.id,
          ok: true,
          result: {
            daemon: db.getDaemonState(),
            overview: db.getOverview(),
            projection: db.getProjectionBacklog(),
            checkpoints: db.listCheckpointSummary(),
            recentRuns: db.listRecentRuns(),
            ...buildIntegrationStatus(db),
            socketPath: CUED_SOCKET_PATH,
            dbPath: db.dbPath,
          },
        };
      case "doctor":
        return {
          id: request.id,
          ok: true,
          result: {
            ...buildDoctorReport(db),
            projection: db.getProjectionBacklog(),
            autoSyncTargets: getAutoSyncTargets(db),
            autoSyncIntervalMs: getAutoSyncIntervalMs(),
            ingestConcurrency: getIngestConcurrency(),
            ...buildIntegrationStatus(db),
            hooks: doctorHooksConfig(),
          },
        };
      case "integrations-list":
        return {
          id: request.id,
          ok: true,
          result: buildIntegrationStatus(db),
        };
      case "integrations-refresh":
        return {
          id: request.id,
          ok: true,
          result: await refreshManagedIntegrationStates(db),
        };
      case "integrations-connect":
        {
          const started = await startManagedAuth(
            db,
            request.platform,
            request.accountKey,
            activeAuthSessions,
          );
          return {
            id: request.id,
            ok: true,
            result: started,
          };
        }
      case "integrations-disconnect":
        return {
          id: request.id,
          ok: true,
          result: disconnectIntegration(db, request.platform, request.accountKey),
        };
      case "integrations-auth-status":
        return {
          id: request.id,
          ok: true,
          result: { authSession: getAuthSessionSummary(db, request.sessionId) },
        };
      case "integrations-auth-cancel":
        {
          const existing = db.getAuthSession(request.sessionId);
          if (!existing) {
            throw new Error(`Auth session not found: ${request.sessionId}`);
          }
          const active = activeAuthSessions.get(request.sessionId);
          if (active) {
            active.child.kill("SIGTERM");
            activeAuthSessions.delete(request.sessionId);
          }
          return {
            id: request.id,
            ok: true,
            result: completeAuthSession(db, request.sessionId, {
              state: "cancelled",
              errorSummary: null,
            }),
          };
        }
      case "integrations-enable":
        return {
          id: request.id,
          ok: true,
          result: setIntegrationEnabled(db, request.platform, request.accountKey, true),
        };
      case "integrations-disable":
        return {
          id: request.id,
          ok: true,
          result: setIntegrationEnabled(db, request.platform, request.accountKey, false),
        };
      case "sync-run":
        if (request.source && !isAdapterPlatform(request.source)) {
          throw new Error(`Unsupported sync source: ${request.source}`);
        }
        return {
          id: request.id,
          ok: true,
          result: {
            queued: true,
            runId: db.queueSyncRun({
              platform: request.source && isAdapterPlatform(request.source) ? request.source : null,
              runType: "sync",
              trigger: "cli",
              details: { source: request.source ?? null },
            }),
          },
        };
      case "sync-resume":
        {
          const platforms = new Set([
            ...getAutoSyncTargets(db).map((target) => `${target.platform}:${target.accountKey}`),
            ...db.listCheckpointTargets()
              .filter((target) => isAdapterPlatform(target.platform))
              .map((target) => `${target.platform}:${target.account_key}`),
          ]);
          const queuedRunIds: string[] = [];
          for (const targetKey of platforms) {
            const [platform, accountKey] = targetKey.split(":");
            if (!platform || !accountKey || !isAdapterPlatform(platform)) {
              continue;
            }
            if (db.hasQueuedOrRunningRun(platform, accountKey)) {
              continue;
            }

            queuedRunIds.push(
              db.queueSyncRun({
                platform,
                accountKey,
                runType: "sync_resume",
                trigger: "cli",
                details: { source: platform, accountKey },
              }),
            );
          }

          return {
            id: request.id,
            ok: true,
            result: {
              queued: queuedRunIds.length > 0,
              runIds: queuedRunIds,
              targets: [...platforms],
            },
          };
        }
      case "rebuild":
        return {
          id: request.id,
          ok: true,
          result: {
            queued: true,
            runId: db.queueSyncRun({
              runType: "rebuild",
              trigger: "cli",
              details: { trigger: "cli" },
            }),
          },
        };
      case "reset":
        if (!isPlatform(request.source)) {
          throw new Error(`Unsupported reset source: ${request.source}`);
        }
        return {
          id: request.id,
          ok: true,
          result: {
            source: request.source,
            rowsRemoved: db.resetSource(request.source),
          },
        };
      case "merge-contact":
        return {
          id: request.id,
          ok: true,
          result: {
            decisionId: db.insertMergeDecision({
              decisionType: "merge",
              leftContactId: request.leftContactId,
              rightContactId: request.rightContactId,
              canonicalContactId: request.leftContactId,
              reason: request.reason ?? "manual_cli_merge",
              createdBy: "cli",
            }),
          },
        };
      case "split-contact":
        return {
          id: request.id,
          ok: true,
          result: {
            decisionId: db.insertMergeDecision({
              decisionType: "split",
              canonicalContactId: request.contactId,
              reason: request.reason ?? "manual_cli_split",
              createdBy: "cli",
            }),
          },
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
