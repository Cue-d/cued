import { createServer } from "node:net";
import { existsSync, rmSync } from "node:fs";
import process from "node:process";
import { CUED_SOCKET_PATH } from "../config.js";
import { openCuedDatabase } from "../db/database.js";
import { buildDoctorReport } from "../diagnostics/doctor.js";
import { runAdapter } from "../adapters/runner.js";
import { isAdapterPlatform, listAutoSyncPlatforms } from "../adapters/registry.js";
import { buildIntegrationStatus, completeAuthSession, connectIntegration, disconnectIntegration, getAuthSessionSummary, getIntegrationSummary, launchIntegration, markAuthSessionInProgress, refreshManagedIntegrationStates, setIntegrationEnabled, } from "../integrations/service.js";
import { startAuthSession } from "../integrations/auth-runtime.js";
import { doctorHooksConfig, emitHookEvent } from "../hooks/service.js";
import { rebuildProjectedState } from "../projector/projector.js";
import { getDefaultAccountKeyForPlatform, isPlatform, } from "../types/provider.js";
const DAEMON_VERSION = "0.1.0";
const DEFAULT_AUTOSYNC_INTERVAL_MS = 60_000;
function now() {
    return Date.now();
}
function getAutoSyncTargets(db) {
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
        .filter((target) => isAdapterPlatform(target.platform))
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
function getAutoSyncIntervalMs() {
    const configured = Number(process.env.CUED_AUTOSYNC_INTERVAL_MS ?? DEFAULT_AUTOSYNC_INTERVAL_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_AUTOSYNC_INTERVAL_MS;
}
async function safeEmitHookEvent(event, payload) {
    try {
        await emitHookEvent(event, payload);
    }
    catch (error) {
        console.warn(`[cued hooks] ${event} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}
async function emitAuthenticatedHook(db, platform, accountKey, sessionId) {
    await safeEmitHookEvent("integration.authenticated", {
        integration: getIntegrationSummary(db, platform, accountKey),
        authSession: getAuthSessionSummary(db, sessionId),
    });
}
function isInboundMessageEvent(rawEvent) {
    return rawEvent.entityKind === "message"
        && rawEvent.eventKind === "message_created"
        && typeof rawEvent.payload === "object"
        && rawEvent.payload !== null
        && typeof rawEvent.payload.senderSourceKey === "string"
        && rawEvent.payload.senderSourceKey.length > 0;
}
async function startManagedAuth(db, platform, accountKey, activeAuthSessions) {
    const requested = connectIntegration(db, platform, accountKey);
    const integration = getIntegrationSummary(db, requested.integration.platform, requested.integration.accountKey);
    const runtime = startAuthSession(db, requested.authSession, integration);
    const running = markAuthSessionInProgress(db, requested.authSession.id, runtime.child.pid ?? process.pid);
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
export async function runDaemon() {
    const db = openCuedDatabase();
    const startedAt = now();
    const autoSyncIntervalMs = getAutoSyncIntervalMs();
    const activeAuthSessions = new Map();
    refreshManagedIntegrationStates(db);
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
    const queueAutoSyncRuns = (trigger) => {
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
    queueAutoSyncRuns("daemon_start");
    const workLoop = setInterval(async () => {
        let currentRun = null;
        try {
            currentRun = db.claimNextQueuedRun();
            if (!currentRun)
                return;
            if (currentRun.run_type === "rebuild") {
                const projected = rebuildProjectedState(db);
                db.finishRun(currentRun.id, { projected });
                await safeEmitHookEvent("sync.completed", {
                    runId: currentRun.id,
                    platform: currentRun.platform,
                    runType: currentRun.run_type,
                    projected,
                });
                return;
            }
            if ((currentRun.run_type === "sync" || currentRun.run_type === "sync_resume")
                && currentRun.platform) {
                if (!isAdapterPlatform(currentRun.platform)) {
                    db.failRun(currentRun.id, `No adapter registered for platform: ${currentRun.platform}`);
                    return;
                }
                const accountKey = currentRun.account_key ?? getDefaultAccountKeyForPlatform(currentRun.platform);
                const checkpoint = db.getCheckpoint(currentRun.platform, accountKey);
                const sourceCursor = checkpoint?.source_cursor_json
                    ? JSON.parse(checkpoint.source_cursor_json)
                    : null;
                const envOverrides = {};
                if (currentRun.platform === "imessage" && typeof sourceCursor?.rowId === "number") {
                    envOverrides.CUED_IMESSAGE_LAST_ROWID = String(sourceCursor.rowId);
                }
                const bundle = await runAdapter(currentRun.platform, accountKey, envOverrides);
                const inboundMessages = [];
                for (const account of bundle.sourceAccounts) {
                    db.upsertSourceAccount(account);
                }
                for (const rawEvent of bundle.rawEvents) {
                    const inserted = db.insertRawEvent(rawEvent);
                    if (inserted && isInboundMessageEvent({ ...rawEvent, payload: rawEvent.payload })) {
                        inboundMessages.push({
                            platform: rawEvent.platform,
                            accountKey: rawEvent.accountKey,
                            observedAt: rawEvent.observedAt,
                            payload: rawEvent.payload,
                        });
                    }
                }
                const projected = rebuildProjectedState(db);
                db.upsertCheckpoint({
                    platform: currentRun.platform,
                    accountKey,
                    syncMode: bundle.syncMode ?? "full",
                    sourceCursor: bundle.sourceCursor,
                    rawIngestWatermark: projected.rawEvents,
                    projectionWatermark: projected.messages,
                    lastSuccessAt: now(),
                });
                db.finishRun(currentRun.id, {
                    ingested: bundle.rawEvents.length,
                    projected,
                });
                await safeEmitHookEvent("sync.completed", {
                    runId: currentRun.id,
                    platform: currentRun.platform,
                    accountKey,
                    runType: currentRun.run_type,
                    ingested: bundle.rawEvents.length,
                    projected,
                });
                for (const message of inboundMessages) {
                    await safeEmitHookEvent("message.received", {
                        runId: currentRun.id,
                        message,
                    });
                }
                return;
            }
            db.failRun(currentRun.id, `Unsupported run target: ${currentRun.run_type}:${currentRun.platform ?? "none"}`);
        }
        catch (error) {
            if (currentRun) {
                db.failRun(currentRun.id, error instanceof Error ? error.message : String(error));
                await safeEmitHookEvent("sync.failed", {
                    runId: currentRun.id,
                    platform: currentRun.platform,
                    runType: currentRun.run_type,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }, 500);
    const schedulerLoop = setInterval(() => {
        queueAutoSyncRuns("scheduler");
    }, autoSyncIntervalMs);
    const server = createServer((socket) => {
        handleSocket(socket, db, activeAuthSessions);
    });
    server.listen(CUED_SOCKET_PATH);
    const shutdown = () => {
        clearInterval(heartbeat);
        clearInterval(workLoop);
        clearInterval(schedulerLoop);
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
function writeResponse(socket, response) {
    socket.write(`${JSON.stringify(response)}\n`);
}
function handleSocket(socket, db, activeAuthSessions) {
    let buffer = "";
    socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (line.length > 0) {
                let request = null;
                try {
                    request = JSON.parse(line);
                }
                catch {
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
async function dispatchRequest(db, request, activeAuthSessions) {
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
                        autoSyncTargets: getAutoSyncTargets(db),
                        autoSyncIntervalMs: getAutoSyncIntervalMs(),
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
                    result: refreshManagedIntegrationStates(db),
                };
            case "integrations-connect":
            case "integrations-request-access":
                {
                    const started = await startManagedAuth(db, request.platform, request.accountKey, activeAuthSessions);
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
            case "integrations-login":
                if (["slack", "linkedin", "twitter", "x"].includes(request.platform.toLowerCase())) {
                    return dispatchRequest(db, {
                        id: request.id,
                        command: "integrations-connect",
                        platform: request.platform,
                        accountKey: request.accountKey,
                    }, activeAuthSessions);
                }
                return {
                    id: request.id,
                    ok: true,
                    result: launchIntegration(db, request.platform, request.accountKey),
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
                    const queuedRunIds = [];
                    for (const targetKey of platforms) {
                        const [platform, accountKey] = targetKey.split(":");
                        if (!platform || !accountKey || !isAdapterPlatform(platform)) {
                            continue;
                        }
                        if (db.hasQueuedOrRunningRun(platform, accountKey)) {
                            continue;
                        }
                        queuedRunIds.push(db.queueSyncRun({
                            platform,
                            accountKey,
                            runType: "sync_resume",
                            trigger: "cli",
                            details: { source: platform, accountKey },
                        }));
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
                        }),
                        message: `${request.command} is queued; adapter/projector execution is not implemented yet`,
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
                    id: request,
                    ok: false,
                    error: "Unsupported command",
                };
        }
    }
    catch (error) {
        return {
            id: request.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
//# sourceMappingURL=server.js.map