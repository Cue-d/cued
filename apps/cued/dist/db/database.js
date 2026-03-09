import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { ensureCuedDirs, CUED_DB_PATH } from "../config.js";
import { MIGRATIONS } from "./migrations.js";
import * as schema from "./schema.js";
const { authSessions, contactMergeDecisions, contactObservations, contactFieldValues, contactHandles, contactSources, contacts, conversationObservations, conversationParticipants, conversations, daemonState, integrationStates, messageEvents, messageReactions, messages, participantEvents, rawEvents, schemaMigrations, sourceAccounts, syncCheckpoints, syncRunErrors, syncRuns, } = schema;
function now() {
    return Date.now();
}
export class CuedDatabase {
    dbPath;
    sqlite;
    db;
    constructor(dbPath = CUED_DB_PATH) {
        this.dbPath = dbPath;
        ensureCuedDirs();
        this.sqlite = new Database(dbPath);
        this.sqlite.exec("PRAGMA journal_mode = WAL");
        this.sqlite.exec("PRAGMA foreign_keys = ON");
        this.sqlite.exec("PRAGMA synchronous = NORMAL");
        this.db = drizzle(this.sqlite, { schema });
    }
    migrate() {
        for (const migration of MIGRATIONS) {
            const alreadyApplied = this.sqlite
                .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
                .get();
            if (alreadyApplied) {
                const applied = this.sqlite
                    .prepare("SELECT id FROM schema_migrations WHERE id = ?")
                    .get(migration.id);
                if (applied) {
                    continue;
                }
            }
            this.sqlite.exec("BEGIN");
            try {
                this.sqlite.exec(migration.sql);
                this.sqlite
                    .prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)")
                    .run(migration.id, now());
                this.sqlite.exec("COMMIT");
            }
            catch (error) {
                this.sqlite.exec("ROLLBACK");
                throw error;
            }
        }
    }
    close() {
        this.sqlite.close();
    }
    orm() {
        return this.db;
    }
    getDaemonState() {
        const row = this.db
            .select({
            singleton_key: daemonState.singletonKey,
            pid: daemonState.pid,
            started_at: daemonState.startedAt,
            updated_at: daemonState.updatedAt,
            status: daemonState.status,
            version: daemonState.version,
            details_json: daemonState.detailsJson,
        })
            .from(daemonState)
            .where(eq(daemonState.singletonKey, "daemon"))
            .get();
        return row ? { ...row, singleton_key: "daemon" } : null;
    }
    upsertDaemonState(input) {
        this.db
            .insert(daemonState)
            .values({
            singletonKey: "daemon",
            pid: input.pid,
            startedAt: input.startedAt,
            updatedAt: input.updatedAt,
            status: input.status,
            version: input.version ?? null,
            detailsJson: input.details ? JSON.stringify(input.details) : null,
        })
            .onConflictDoUpdate({
            target: daemonState.singletonKey,
            set: {
                pid: input.pid,
                startedAt: input.startedAt,
                updatedAt: input.updatedAt,
                status: input.status,
                version: input.version ?? null,
                detailsJson: input.details ? JSON.stringify(input.details) : null,
            },
        })
            .run();
    }
    listCheckpointSummary() {
        return this.db
            .select({
            platform: syncCheckpoints.platform,
            account_key: syncCheckpoints.accountKey,
            sync_mode: syncCheckpoints.syncMode,
            last_success_at: syncCheckpoints.lastSuccessAt,
            last_error_summary: syncCheckpoints.lastErrorSummary,
        })
            .from(syncCheckpoints)
            .orderBy(asc(syncCheckpoints.platform), asc(syncCheckpoints.accountKey))
            .all();
    }
    getCheckpoint(platform, accountKey) {
        return this.db
            .select({
            source_cursor_json: syncCheckpoints.sourceCursorJson,
            sync_mode: syncCheckpoints.syncMode,
            raw_ingest_watermark: syncCheckpoints.rawIngestWatermark,
            projection_watermark: syncCheckpoints.projectionWatermark,
        })
            .from(syncCheckpoints)
            .where(and(eq(syncCheckpoints.platform, platform), eq(syncCheckpoints.accountKey, accountKey)))
            .get() ?? null;
    }
    resetSource(platform) {
        return this.db.transaction((tx) => {
            const removedRuns = tx.delete(syncRuns).where(eq(syncRuns.platform, platform)).run().changes;
            const removedErrors = tx.delete(syncRunErrors).where(eq(syncRunErrors.platform, platform)).run().changes;
            const removedCheckpoints = tx.delete(syncCheckpoints).where(eq(syncCheckpoints.platform, platform)).run().changes;
            return Number(removedRuns) + Number(removedErrors) + Number(removedCheckpoints);
        });
    }
    insertMergeDecision(input) {
        const id = randomUUID();
        this.db.insert(contactMergeDecisions).values({
            id,
            decisionType: input.decisionType,
            leftContactId: input.leftContactId ?? null,
            rightContactId: input.rightContactId ?? null,
            canonicalContactId: input.canonicalContactId ?? null,
            reason: input.reason ?? null,
            createdBy: input.createdBy,
            createdAt: now(),
        }).run();
        return id;
    }
    getOverview() {
        return {
            contacts: this.countRows(contacts),
            conversations: this.countRows(conversations),
            messages: this.countRows(messages),
            rawEvents: this.countRows(rawEvents),
            sourceAccounts: this.countRows(sourceAccounts),
            integrations: this.countRows(integrationStates),
            authSessions: this.countRows(authSessions),
        };
    }
    listIntegrationStates() {
        return this.db
            .select({
            id: integrationStates.id,
            platform: integrationStates.platform,
            account_key: integrationStates.accountKey,
            display_name: integrationStates.displayName,
            auth_state: integrationStates.authState,
            enabled: integrationStates.enabled,
            connection_kind: integrationStates.connectionKind,
            sync_capable: integrationStates.syncCapable,
            launch_strategy: integrationStates.launchStrategy,
            launch_target: integrationStates.launchTarget,
            imported_from: integrationStates.importedFrom,
            artifact_paths_json: integrationStates.artifactPathsJson,
            metadata_json: integrationStates.metadataJson,
            last_seen_at: integrationStates.lastSeenAt,
            created_at: integrationStates.createdAt,
            updated_at: integrationStates.updatedAt,
        })
            .from(integrationStates)
            .orderBy(asc(integrationStates.platform), asc(integrationStates.accountKey))
            .all();
    }
    listEnabledSyncPlatforms() {
        return this.db
            .selectDistinct({ platform: integrationStates.platform })
            .from(integrationStates)
            .where(and(eq(integrationStates.enabled, 1), eq(integrationStates.syncCapable, 1)))
            .orderBy(asc(integrationStates.platform))
            .all()
            .map((row) => row.platform);
    }
    listEnabledSyncTargets() {
        return this.db
            .select({
            platform: integrationStates.platform,
            account_key: integrationStates.accountKey,
        })
            .from(integrationStates)
            .where(and(eq(integrationStates.enabled, 1), eq(integrationStates.syncCapable, 1)))
            .orderBy(asc(integrationStates.platform), asc(integrationStates.accountKey))
            .all();
    }
    getIntegrationState(platform, accountKey) {
        return this.db
            .select({
            id: integrationStates.id,
            platform: integrationStates.platform,
            account_key: integrationStates.accountKey,
            display_name: integrationStates.displayName,
            auth_state: integrationStates.authState,
            enabled: integrationStates.enabled,
            connection_kind: integrationStates.connectionKind,
            sync_capable: integrationStates.syncCapable,
            launch_strategy: integrationStates.launchStrategy,
            launch_target: integrationStates.launchTarget,
            imported_from: integrationStates.importedFrom,
            artifact_paths_json: integrationStates.artifactPathsJson,
            metadata_json: integrationStates.metadataJson,
            last_seen_at: integrationStates.lastSeenAt,
            created_at: integrationStates.createdAt,
            updated_at: integrationStates.updatedAt,
        })
            .from(integrationStates)
            .where(and(eq(integrationStates.platform, platform), eq(integrationStates.accountKey, accountKey)))
            .get() ?? null;
    }
    upsertIntegrationState(input) {
        const id = `${input.platform}:${input.accountKey}`;
        const timestamp = now();
        const values = {
            id,
            platform: input.platform,
            accountKey: input.accountKey,
            displayName: input.displayName ?? null,
            authState: input.authState,
            enabled: input.enabled === false ? 0 : 1,
            connectionKind: input.connectionKind,
            syncCapable: input.syncCapable === true ? 1 : 0,
            launchStrategy: input.launchStrategy ?? null,
            launchTarget: input.launchTarget ?? null,
            importedFrom: input.importedFrom ?? null,
            artifactPathsJson: input.artifactPaths ? JSON.stringify(input.artifactPaths) : null,
            metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
            lastSeenAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        this.db
            .insert(integrationStates)
            .values(values)
            .onConflictDoUpdate({
            target: [integrationStates.platform, integrationStates.accountKey],
            set: {
                displayName: values.displayName,
                authState: values.authState,
                enabled: values.enabled,
                connectionKind: values.connectionKind,
                syncCapable: values.syncCapable,
                launchStrategy: values.launchStrategy,
                launchTarget: values.launchTarget,
                importedFrom: values.importedFrom,
                artifactPathsJson: values.artifactPathsJson,
                metadataJson: values.metadataJson,
                lastSeenAt: values.lastSeenAt,
                updatedAt: values.updatedAt,
            },
        })
            .run();
    }
    setIntegrationEnabled(platform, accountKey, enabled) {
        const result = this.db
            .update(integrationStates)
            .set({
            enabled: enabled ? 1 : 0,
            updatedAt: now(),
        })
            .where(and(eq(integrationStates.platform, platform), eq(integrationStates.accountKey, accountKey)))
            .run();
        if (Number(result.changes) === 0) {
            throw new Error(`Integration not found: ${platform}/${accountKey}`);
        }
    }
    listAuthSessions(limit = 20) {
        return this.db
            .select({
            id: authSessions.id,
            platform: authSessions.platform,
            account_key: authSessions.accountKey,
            integration_state_id: authSessions.integrationStateId,
            state: authSessions.state,
            native_pid: authSessions.nativePid,
            requested_at: authSessions.requestedAt,
            started_at: authSessions.startedAt,
            finished_at: authSessions.finishedAt,
            keychain_service: authSessions.keychainService,
            keychain_account: authSessions.keychainAccount,
            result_summary_json: authSessions.resultSummaryJson,
            error_summary: authSessions.errorSummary,
            created_at: authSessions.createdAt,
            updated_at: authSessions.updatedAt,
        })
            .from(authSessions)
            .orderBy(desc(authSessions.requestedAt), desc(authSessions.createdAt))
            .limit(limit)
            .all();
    }
    getAuthSession(sessionId) {
        return this.db
            .select({
            id: authSessions.id,
            platform: authSessions.platform,
            account_key: authSessions.accountKey,
            integration_state_id: authSessions.integrationStateId,
            state: authSessions.state,
            native_pid: authSessions.nativePid,
            requested_at: authSessions.requestedAt,
            started_at: authSessions.startedAt,
            finished_at: authSessions.finishedAt,
            keychain_service: authSessions.keychainService,
            keychain_account: authSessions.keychainAccount,
            result_summary_json: authSessions.resultSummaryJson,
            error_summary: authSessions.errorSummary,
            created_at: authSessions.createdAt,
            updated_at: authSessions.updatedAt,
        })
            .from(authSessions)
            .where(eq(authSessions.id, sessionId))
            .get() ?? null;
    }
    getLatestAuthSession(platform, accountKey) {
        return this.db
            .select({
            id: authSessions.id,
            platform: authSessions.platform,
            account_key: authSessions.accountKey,
            integration_state_id: authSessions.integrationStateId,
            state: authSessions.state,
            native_pid: authSessions.nativePid,
            requested_at: authSessions.requestedAt,
            started_at: authSessions.startedAt,
            finished_at: authSessions.finishedAt,
            keychain_service: authSessions.keychainService,
            keychain_account: authSessions.keychainAccount,
            result_summary_json: authSessions.resultSummaryJson,
            error_summary: authSessions.errorSummary,
            created_at: authSessions.createdAt,
            updated_at: authSessions.updatedAt,
        })
            .from(authSessions)
            .where(and(eq(authSessions.platform, platform), eq(authSessions.accountKey, accountKey)))
            .orderBy(desc(authSessions.requestedAt), desc(authSessions.createdAt))
            .limit(1)
            .get() ?? null;
    }
    createAuthSession(input) {
        const id = input.id ?? randomUUID();
        const timestamp = input.requestedAt ?? now();
        this.db.insert(authSessions).values({
            id,
            platform: input.platform,
            accountKey: input.accountKey,
            integrationStateId: input.integrationStateId,
            state: input.state ?? "requested",
            nativePid: null,
            requestedAt: timestamp,
            startedAt: null,
            finishedAt: null,
            keychainService: null,
            keychainAccount: null,
            resultSummaryJson: input.resultSummary ? JSON.stringify(input.resultSummary) : null,
            errorSummary: input.errorSummary ?? null,
            createdAt: timestamp,
            updatedAt: timestamp,
        }).run();
        return id;
    }
    updateAuthSessionState(input) {
        const current = this.getAuthSession(input.id);
        if (!current) {
            throw new Error(`Auth session not found: ${input.id}`);
        }
        this.db.update(authSessions).set({
            state: input.state,
            nativePid: input.nativePid === undefined ? current.native_pid : input.nativePid,
            startedAt: input.startedAt === undefined ? current.started_at : input.startedAt,
            finishedAt: input.finishedAt === undefined ? current.finished_at : input.finishedAt,
            keychainService: input.keychainService === undefined ? current.keychain_service : input.keychainService,
            keychainAccount: input.keychainAccount === undefined ? current.keychain_account : input.keychainAccount,
            resultSummaryJson: input.resultSummary === undefined
                ? current.result_summary_json
                : input.resultSummary === null
                    ? null
                    : JSON.stringify(input.resultSummary),
            errorSummary: input.errorSummary === undefined ? current.error_summary : input.errorSummary,
            updatedAt: now(),
        }).where(eq(authSessions.id, input.id)).run();
    }
    queueSyncRun(input) {
        const id = randomUUID();
        this.db.insert(syncRuns).values({
            id,
            platform: input.platform ?? null,
            accountKey: input.accountKey ?? null,
            runType: input.runType,
            status: "queued",
            trigger: input.trigger,
            startedAt: now(),
            finishedAt: null,
            detailsJson: input.details ? JSON.stringify(input.details) : null,
        }).run();
        return id;
    }
    hasQueuedOrRunningRun(platform, accountKey) {
        const accountPredicate = accountKey == null
            ? sql `1 = 1`
            : eq(syncRuns.accountKey, accountKey);
        return Boolean(this.db
            .select({ id: syncRuns.id })
            .from(syncRuns)
            .where(and(eq(syncRuns.platform, platform), accountPredicate, inArray(syncRuns.status, ["queued", "running"])))
            .limit(1)
            .get());
    }
    listCheckpointPlatforms() {
        return this.db
            .selectDistinct({ platform: syncCheckpoints.platform })
            .from(syncCheckpoints)
            .orderBy(asc(syncCheckpoints.platform))
            .all()
            .map((row) => row.platform);
    }
    listCheckpointTargets() {
        return this.db
            .select({
            platform: syncCheckpoints.platform,
            account_key: syncCheckpoints.accountKey,
        })
            .from(syncCheckpoints)
            .orderBy(asc(syncCheckpoints.platform), asc(syncCheckpoints.accountKey))
            .all();
    }
    listRecentRuns(limit = 10) {
        return this.db
            .select({
            id: syncRuns.id,
            platform: syncRuns.platform,
            account_key: syncRuns.accountKey,
            run_type: syncRuns.runType,
            status: syncRuns.status,
            trigger: syncRuns.trigger,
            started_at: syncRuns.startedAt,
            finished_at: syncRuns.finishedAt,
        })
            .from(syncRuns)
            .orderBy(desc(syncRuns.startedAt))
            .limit(limit)
            .all();
    }
    claimNextQueuedRun() {
        return this.db.transaction((tx) => {
            const row = tx
                .select({
                id: syncRuns.id,
                platform: syncRuns.platform,
                account_key: syncRuns.accountKey,
                run_type: syncRuns.runType,
                status: syncRuns.status,
                trigger: syncRuns.trigger,
                started_at: syncRuns.startedAt,
                details_json: syncRuns.detailsJson,
            })
                .from(syncRuns)
                .where(eq(syncRuns.status, "queued"))
                .orderBy(asc(syncRuns.startedAt))
                .limit(1)
                .get();
            if (!row) {
                return null;
            }
            tx.update(syncRuns)
                .set({ status: "running" })
                .where(eq(syncRuns.id, row.id))
                .run();
            return { ...row, status: "running" };
        });
    }
    finishRun(runId, details) {
        const values = details === undefined
            ? {
                status: "completed",
                finishedAt: now(),
            }
            : {
                status: "completed",
                finishedAt: now(),
                detailsJson: JSON.stringify(details),
            };
        this.db
            .update(syncRuns)
            .set(values)
            .where(eq(syncRuns.id, runId))
            .run();
    }
    failRun(runId, errorMessage, details) {
        this.db.transaction((tx) => {
            const values = details === undefined
                ? {
                    status: "failed",
                    finishedAt: now(),
                }
                : {
                    status: "failed",
                    finishedAt: now(),
                    detailsJson: JSON.stringify(details),
                };
            tx.update(syncRuns)
                .set(values)
                .where(eq(syncRuns.id, runId))
                .run();
            tx.insert(syncRunErrors).values({
                id: randomUUID(),
                syncRunId: runId,
                errorMessage,
                detailsJson: details ? JSON.stringify(details) : null,
                createdAt: now(),
            }).run();
        });
    }
    upsertSourceAccount(input) {
        const timestamp = now();
        const values = {
            id: `${input.platform}:${input.accountKey}`,
            platform: input.platform,
            accountKey: input.accountKey,
            displayName: input.displayName ?? null,
            status: input.status ?? "active",
            metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        this.db
            .insert(sourceAccounts)
            .values(values)
            .onConflictDoUpdate({
            target: [sourceAccounts.platform, sourceAccounts.accountKey],
            set: {
                displayName: values.displayName,
                status: values.status,
                metadataJson: values.metadataJson,
                updatedAt: values.updatedAt,
            },
        })
            .run();
    }
    upsertCheckpoint(input) {
        const timestamp = now();
        const values = {
            id: `${input.platform}:${input.accountKey}`,
            platform: input.platform,
            accountKey: input.accountKey,
            sourceCursorJson: input.sourceCursor ? JSON.stringify(input.sourceCursor) : null,
            rawIngestWatermark: input.rawIngestWatermark ?? 0,
            projectionWatermark: input.projectionWatermark ?? 0,
            syncMode: input.syncMode,
            lastFullSyncAt: input.lastSuccessAt ?? null,
            lastSuccessAt: input.lastSuccessAt ?? null,
            lastErrorAt: null,
            lastErrorSummary: input.lastErrorSummary ?? null,
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        this.db
            .insert(syncCheckpoints)
            .values(values)
            .onConflictDoUpdate({
            target: [syncCheckpoints.platform, syncCheckpoints.accountKey],
            set: {
                sourceCursorJson: values.sourceCursorJson,
                rawIngestWatermark: values.rawIngestWatermark,
                projectionWatermark: values.projectionWatermark,
                syncMode: values.syncMode,
                lastFullSyncAt: input.syncMode === "full"
                    ? values.lastSuccessAt
                    : sql `${syncCheckpoints.lastFullSyncAt}`,
                lastSuccessAt: values.lastSuccessAt,
                lastErrorSummary: values.lastErrorSummary,
                updatedAt: values.updatedAt,
            },
        })
            .run();
    }
    insertRawEvent(event) {
        const result = this.db
            .insert(rawEvents)
            .values({
            id: event.id,
            platform: event.platform,
            accountKey: event.accountKey,
            entityKind: event.entityKind,
            eventKind: event.eventKind,
            externalEventId: event.externalEventId ?? null,
            externalEntityId: event.externalEntityId ?? null,
            conversationExternalId: event.conversationExternalId ?? null,
            occurredAt: event.occurredAt ?? null,
            observedAt: event.observedAt,
            cursorJson: event.cursor ? JSON.stringify(event.cursor) : null,
            dedupeKey: event.dedupeKey,
            payloadJson: JSON.stringify(event.payload),
            sourceVersion: event.sourceVersion ?? null,
        })
            .onConflictDoNothing()
            .run();
        return Number(result.changes) > 0;
    }
    listRawEvents() {
        return this.db
            .select({
            id: rawEvents.id,
            platform: rawEvents.platform,
            account_key: rawEvents.accountKey,
            entity_kind: rawEvents.entityKind,
            event_kind: rawEvents.eventKind,
            observed_at: rawEvents.observedAt,
            payload_json: rawEvents.payloadJson,
        })
            .from(rawEvents)
            .orderBy(asc(rawEvents.observedAt), asc(rawEvents.id))
            .all();
    }
    clearProjectedState() {
        this.db.transaction((tx) => {
            tx.run(sql.raw("DELETE FROM messages_fts"));
            tx.delete(messageReactions).run();
            tx.delete(messageEvents).run();
            tx.delete(participantEvents).run();
            tx.delete(contactObservations).run();
            tx.delete(conversationObservations).run();
            tx.delete(conversationParticipants).run();
            tx.delete(messages).run();
            tx.delete(conversations).run();
            tx.delete(contactFieldValues).run();
            tx.delete(contactHandles).run();
            tx.delete(contactSources).run();
            tx.delete(contacts).run();
        });
    }
    countRows(table) {
        const row = this.db
            .select({ count: sql `count(*)` })
            .from(table)
            .get();
        return Number(row?.count ?? 0);
    }
}
export function openCuedDatabase(dbPath) {
    const db = new CuedDatabase(dbPath);
    db.migrate();
    return db;
}
//# sourceMappingURL=database.js.map