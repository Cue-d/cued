import type { ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import process from "node:process";
import { getCurrentAppVersion } from "../../core/app-metadata.js";
import { CUED_SOCKET_PATH } from "../../core/config.js";
import { createLogger } from "../../core/logging.js";
import type { AdapterPlatform, Platform } from "../../core/types/provider.js";
import { safeParseJsonRecord } from "../../db/codecs.js";
import type { openCuedDatabase } from "../../db/database.js";
import type { DbWorker } from "../../db/db-worker.js";
import { reconcileAbandonedAuthSessions } from "../../platforms/core/state/status.js";
import type { DiscordRealtimeSupervisor } from "../../platforms/discord/realtime/session.js";
import { GmailClient } from "../../platforms/gmail/api/client.js";
import type { LinkedInRealtimeSupervisor } from "../../platforms/linkedin/realtime/session.js";
import type { SignalRealtimeSupervisor } from "../../platforms/signal/realtime/session.js";
import type { SlackRealtimeSupervisor } from "../../platforms/slack/realtime/session.js";
import type { WhatsAppRealtimeSupervisor } from "../../platforms/whatsapp/realtime/session.js";
import type { DaemonTelemetryQueue } from "../../telemetry/queue.js";
import { fetchAttachment, listAttachments, searchAttachments } from "../attachments.js";
import { buildPermissionStatus } from "../doctor.js";
import type { DaemonRequest, DaemonResponse } from "../ipc.js";
import { buildOnboardingSnapshot, transitionOnboarding } from "../onboarding.js";
import { RunQueueService } from "../run-queue.js";
import {
  buildDoctorSnapshot,
  type DaemonBootstrapSnapshot,
  type RealtimeSessionStatuses,
} from "../status.js";
import { buildSyncResumeTargets, getAutoSyncTargets } from "./auto-sync-targets.js";
import { emitAuthenticatedHook } from "./hook-events.js";
import type { DaemonReadModel } from "./read-model.js";
import {
  DAEMON_STATUS_BUSY_TIMEOUT_MS,
  DAEMON_STATUS_CACHE_MAX_AGE_MS,
  getAutoSyncIntervalMs,
  getDeferredProjectionCoalesceMs,
  getIngestConcurrency,
  getProjectionBatchSize,
  getRealtimeProjectionBatchSize,
  getRealtimeProjectionEnabled,
  isSqliteBusyError,
  now,
  WHATSAPP_ATTACHMENT_SESSION_WAIT_MS,
} from "./settings.js";
import type { StallMonitor } from "./stall-monitor.js";
import {
  buildDaemonBusyStatusSnapshot,
  DAEMON_VERSION,
  getAppStatusMetadata,
  getDaemonIdentity,
  readCachedDaemonStatusSnapshot,
} from "./status-snapshot.js";

const daemonLogger = createLogger("daemon");

type QueueSchedulers = {
  wakeIngest: (delayMs?: number) => void;
  wakeProjection: (delayMs?: number) => void;
  wakeSearchIndex: (delayMs?: number) => void;
};

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

/** Everything a daemon request handler can reach, owned by `runDaemon`. */
type DaemonRequestContext = {
  db: ReturnType<typeof openCuedDatabase>;
  telemetry: DaemonTelemetryQueue;
  activeAuthSessions: Map<string, { child: ChildProcess; platform: Platform; accountKey: string }>;
  schedulers: QueueSchedulers;
  discordRealtime: DiscordRealtimeSupervisor;
  slackRealtime: SlackRealtimeSupervisor;
  linkedInRealtime: LinkedInRealtimeSupervisor;
  signalRealtime: SignalRealtimeSupervisor;
  whatsAppRealtime: WhatsAppRealtimeSupervisor;
  bootstrap: DaemonBootstrapSnapshot;
  requestRealtimeReconcile: () => void;
  reconcileLocalWatchers: () => void;
  requestUpdateShutdown: () => { shuttingDown: boolean; requestedAt: number | null };
  isBackgroundWorkActive: () => boolean;
  onAuthRuntimeStateChanged: () => void;
  /** Sign-in browser progress was recorded; subscribers re-read the snapshot. */
  onAuthRuntimeProgress: () => void;
  refreshStatusCacheNow: (reason: string) => void;
  shouldRunRealtimePlatform: (platform: AdapterPlatform) => boolean;
  purgeAccountSyncRunHistory: (
    platform: Platform,
    accountKey: string,
    queuedBefore: number,
  ) => void;
  dbWorker: DbWorker;
  readModel: DaemonReadModel;
  realtimeStatuses: () => RealtimeSessionStatuses;
  subscribe: (socket: Socket) => void;
  refreshManagedIntegrationsInBackground: (reason: string) => void;
  recheckLocalAccessForManualSync: (source: string | undefined) => Promise<void>;
  stallMonitor: StallMonitor;
  noteForegroundRequest: () => void;
  /** Drops message hooks still waiting on projection for a platform whose rows are gone. */
  discardMessageHooksForPlatform: (platform: string) => void;
};

function handleSocket(socket: Socket, context: DaemonRequestContext): void {
  let buffer = "";

  socket.on("error", handleSocketError);

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        context.stallMonitor.noteActivity();
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

        if (request.command === "subscribe") {
          context.subscribe(socket);
          writeResponse(socket, { id: request.id, ok: true, result: { subscribed: true } });
          newlineIndex = buffer.indexOf("\n");
          continue;
        }

        if (request.command !== "ping") {
          context.noteForegroundRequest();
        }
        // Only the synchronous part of a handler can stall the loop; that is what gets timed.
        const dispatched = request;
        void context.stallMonitor
          .section(`request:${dispatched.command}`, () => dispatchRequest(context, dispatched))
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

function stopActiveAuthSessionsForIntegration(
  activeAuthSessions: Map<string, { child: ChildProcess; platform: Platform; accountKey: string }>,
  platform: Platform,
  accountKey: string | undefined,
): void {
  for (const [sessionId, session] of activeAuthSessions) {
    if (session.platform !== platform) {
      continue;
    }
    if (accountKey != null && session.accountKey !== accountKey) {
      continue;
    }
    try {
      session.child.kill("SIGTERM");
    } catch (error) {
      daemonLogger.warn("failed to stop auth session during integration removal", {
        platform,
        accountKey: session.accountKey,
        error,
      });
    }
    activeAuthSessions.delete(sessionId);
  }
}

async function dispatchRequest(
  context: DaemonRequestContext,
  request: DaemonRequest,
): Promise<DaemonResponse> {
  const {
    db,
    telemetry,
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
    isBackgroundWorkActive,
    onAuthRuntimeStateChanged,
    onAuthRuntimeProgress,
    refreshStatusCacheNow,
    shouldRunRealtimePlatform,
    purgeAccountSyncRunHistory,
    dbWorker,
    readModel,
    realtimeStatuses,
    refreshManagedIntegrationsInBackground,
    recheckLocalAccessForManualSync,
  } = context;
  try {
    const runQueueService = new RunQueueService(db, schedulers);
    const getIntegrationAuthService = async () => {
      const { IntegrationAuthService } = await import("../../platforms/core/auth/service.js");
      return new IntegrationAuthService(db, { awaitTelemetry: false });
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
      case "status": {
        const cached = readCachedDaemonStatusSnapshot({
          maxAgeMs: DAEMON_STATUS_CACHE_MAX_AGE_MS,
        });
        if (cached) {
          return {
            id: request.id,
            ok: true,
            result: {
              ...cached,
              statusCacheHit: true,
            },
          };
        }
        // The full snapshot scans large tables; build it on the database worker so the daemon
        // keeps answering other requests meanwhile.
        return {
          id: request.id,
          ok: true,
          result: await dbWorker.run("daemonStatus", {
            app: getAppStatusMetadata(db),
            realtime: realtimeStatuses(),
            socketPath: CUED_SOCKET_PATH,
            bootstrap,
          }),
        };
      }
      case "doctor":
        if (isBackgroundWorkActive()) {
          return {
            id: request.id,
            ok: true,
            result: {
              ...buildDaemonBusyStatusSnapshot({
                realtime: realtimeStatuses(),
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
                realtime: realtimeStatuses(),
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
        return {
          id: request.id,
          ok: true,
          result: await db.withBusyTimeout(DAEMON_STATUS_BUSY_TIMEOUT_MS, () =>
            buildPermissionStatus({
              mode: "passive",
              db,
            }),
          ),
        };
      case "onboarding-status":
        return {
          id: request.id,
          ok: true,
          result: db.getAppMetadata(),
        };
      case "telemetry-app-launched":
        if (request.appVersion !== getCurrentAppVersion()) {
          return { id: request.id, ok: false, error: "Unsupported command" };
        }
        telemetry.enqueue("app_launched", {
          component: "native_app",
          operation: "launch",
        });
        return { id: request.id, ok: true, result: { ok: true } };
      case "onboarding-complete":
      case "onboarding-transition": {
        // An older process must let the current CLI persist and report for its own version.
        if (
          request.command === "onboarding-transition" &&
          (request.appVersion !== getCurrentAppVersion() ||
            (request.transition !== "start" && request.transition !== "complete"))
        ) {
          return { id: request.id, ok: false, error: "Unsupported command" };
        }
        const transition =
          request.command === "onboarding-transition" ? request.transition : "complete";
        const result = await transitionOnboarding(db, transition, (event, properties) =>
          telemetry.enqueue(event, properties),
        );
        if (transition === "complete") {
          refreshStatusCacheNow("onboarding_complete");
        }
        return {
          id: request.id,
          ok: true,
          result,
        };
      }
      case "onboarding-snapshot": {
        // Answer from what is already known and refresh behind the response: anything that
        // turns out different is announced to subscribers, who then re-read. The refresh
        // flags therefore mean "check again now", not "make me wait for the check".
        if (request.refreshManagedIntegrations) {
          refreshManagedIntegrationsInBackground("onboarding_snapshot");
        }
        const localAccess = readModel.localAccess ?? (await readModel.refreshLocalAccess());
        void readModel
          .refreshLocalAccess(request.refreshPermissions ? { maxAgeMs: 0 } : {})
          .catch(() => undefined);
        void readModel.refreshAggregates();
        return {
          id: request.id,
          ok: true,
          result: await buildOnboardingSnapshot(db, {
            globalSkillMonitor: readModel.skill,
            localAccess,
            aggregates: readModel.aggregates ?? undefined,
          }),
        };
      }
      case "sql":
        // Arbitrary agent queries can run for seconds; they must not hold the daemon thread.
        return {
          id: request.id,
          ok: true,
          result: await dbWorker.run("sql", request.query),
        };
      case "integrations-list":
        reconcileAbandonedAuthSessions(db);
        return {
          id: request.id,
          ok: true,
          result: await dbWorker.run("integrationStatus", {}),
        };
      case "integrations-refresh": {
        const integrationAuthService = await getIntegrationAuthService();
        await integrationAuthService.refresh();
        requestRealtimeReconcile();
        reconcileLocalWatchers();
        refreshStatusCacheNow("integrations_refresh");
        return {
          id: request.id,
          ok: true,
          result: integrationAuthService.listStatus({ includeDiagnostics: false }),
        };
      }
      case "integrations-interaction-start":
      case "integrations-interaction-end":
        // Older app builds announce that a sign-in screen is open so the daemon would throttle
        // sync and projection around it. Nothing is throttled any more: background work no
        // longer competes with requests. Acknowledged so those builds keep working.
        return {
          id: request.id,
          ok: true,
          result: { active: false, expiresAt: null },
        };
      case "integrations-connect": {
        const integrationAuthService = await getIntegrationAuthService();
        const started = await integrationAuthService.connectManaged(
          request.platform,
          request.accountKey,
          activeAuthSessions,
          {
            wakeIngest: schedulers.wakeIngest,
            onRuntimeStateChanged: onAuthRuntimeStateChanged,
            onRuntimeProgress: onAuthRuntimeProgress,
            shouldQueueAuthenticatedSync: (platform) =>
              platform !== "whatsapp" || shouldRunRealtimePlatform("whatsapp"),
            emitAuthenticatedHook: async (platform, accountKey) => {
              await emitAuthenticatedHook(db, platform, accountKey);
            },
          },
        );
        refreshStatusCacheNow("integrations_connect");
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
        refreshStatusCacheNow("integrations_disconnect");
        return {
          id: request.id,
          ok: true,
          result,
        };
      }
      case "integrations-remove": {
        const integrationAuthService = await getIntegrationAuthService();
        // Finished sync runs are purged in background slices: an account can carry hundreds
        // of thousands of them, and deleting those inline would block every other request.
        const result = integrationAuthService.remove(request.platform, request.accountKey, {
          deferSyncRunHistory: true,
        });
        // Bounded to runs that existed at removal, so re-adding the account right away does
        // not lose the history it starts building.
        purgeAccountSyncRunHistory(result.platform, result.accountKey, now() + 1);
        stopActiveAuthSessionsForIntegration(
          activeAuthSessions,
          result.platform,
          result.accountKey,
        );
        requestRealtimeReconcile();
        reconcileLocalWatchers();
        refreshStatusCacheNow("integrations_remove");
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
        refreshStatusCacheNow("integrations_enable");
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
        refreshStatusCacheNow("integrations_disable");
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
              gmail: async (attachment) => {
                const accessRef = safeParseJsonRecord(
                  attachment.access_ref_json,
                  "message_attachments.access_ref_json",
                );
                const messageId =
                  typeof accessRef?.messageId === "string" ? accessRef.messageId : null;
                const attachmentId =
                  typeof accessRef?.attachmentId === "string" ? accessRef.attachmentId : null;
                if (!messageId || !attachmentId) {
                  throw new Error("Gmail attachment is missing provider fetch coordinates");
                }

                const client = GmailClient.fromKeychain(attachment.account_key);
                const result = await client.getAttachment(messageId, attachmentId);
                return {
                  buffer: Buffer.from(result.data.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
                  mimeType: attachment.mime_type,
                  filename: attachment.filename,
                };
              },
              whatsapp: async (attachment) => {
                const accessRef = safeParseJsonRecord(
                  attachment.access_ref_json,
                  "message_attachments.access_ref_json",
                );
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
                    WHATSAPP_ATTACHMENT_SESSION_WAIT_MS,
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
      case "sync-run":
        // Access granted outside the app (`cued permissions request`) is not in the saved
        // state until something looks again.
        await recheckLocalAccessForManualSync(request.source);
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
      case "reset": {
        const result = runQueueService.resetSource(request.source);
        // The reset deleted the rows these hooks were waiting on. Left queued, the next full
        // rebuild would announce messages that are no longer in the database.
        context.discardMessageHooksForPlatform(result.source);
        return { id: request.id, ok: true, result };
      }
      case "subscribe":
        // handleSocket answers this itself: a subscription belongs to the connection.
        return { id: request.id, ok: false, error: "subscribe is handled per connection" };
      default:
        return {
          // `request` is `never` here only for the compiler: an unknown command from a newer
          // or older client still needs its own id echoed, or it can never match the reply.
          id: (request satisfies never as { id?: unknown }).id?.toString() ?? "unknown",
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

export { handleSocket, type DaemonRequestContext };
