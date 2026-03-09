import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import Database from "better-sqlite3";
import { ensureCuedDirs, CUED_DB_PATH } from "../config.js";
import type {
  AuthSessionState,
  ConnectionKind,
  ConversationType,
  IntegrationAuthState,
  IntegrationLaunchStrategy,
  MergeDecisionType,
  Platform,
  ProviderRawEventInput,
  RawEventEntityKind,
  SyncMode,
  SyncRunStatus,
  SyncRunType,
} from "../types/provider.js";
import { MIGRATIONS } from "./migrations.js";
import * as schema from "./schema.js";

const {
  authSessions,
  contactMergeDecisions,
  contactObservations,
  contactFieldValues,
  contactHandles,
  contactSources,
  contacts,
  conversationObservations,
  conversationParticipants,
  conversations,
  daemonState,
  integrationStates,
  messageEvents,
  messageReactions,
  messages,
  participantEvents,
  rawEvents,
  schemaMigrations,
  sourceAccounts,
  syncCheckpoints,
  syncRunErrors,
  syncRuns,
} = schema;

export interface DaemonStatusRow {
  singleton_key: "daemon";
  pid: number | null;
  started_at: number | null;
  updated_at: number | null;
  status: string;
  version: string | null;
  details_json: string | null;
}

export interface QueuedSyncRun {
  id: string;
  platform: Platform | null;
  account_key: string | null;
  run_type: SyncRunType;
  status: SyncRunStatus;
  trigger: string;
  started_at: number;
  details_json: string | null;
}

export type RawEventInput = ProviderRawEventInput;

export interface IntegrationStateRow {
  id: string;
  platform: Platform;
  account_key: string;
  display_name: string | null;
  auth_state: IntegrationAuthState;
  enabled: number;
  connection_kind: ConnectionKind;
  sync_capable: number;
  launch_strategy: IntegrationLaunchStrategy | null;
  launch_target: string | null;
  imported_from: string | null;
  artifact_paths_json: string | null;
  metadata_json: string | null;
  last_seen_at: number;
  created_at: number;
  updated_at: number;
}

export interface AuthSessionRow {
  id: string;
  platform: Platform;
  account_key: string;
  integration_state_id: string;
  state: AuthSessionState;
  native_pid: number | null;
  requested_at: number;
  started_at: number | null;
  finished_at: number | null;
  keychain_service: string | null;
  keychain_account: string | null;
  result_summary_json: string | null;
  error_summary: string | null;
  created_at: number;
  updated_at: number;
}

export type LocalDrizzleDatabase = BetterSQLite3Database<typeof schema>;

function now(): number {
  return Date.now();
}

export class CuedDatabase {
  private readonly sqlite: Database.Database;
  private readonly db: LocalDrizzleDatabase;

  constructor(public readonly dbPath: string = CUED_DB_PATH) {
    ensureCuedDirs();
    this.sqlite = new Database(dbPath);
    this.sqlite.exec("PRAGMA journal_mode = WAL");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.sqlite.exec("PRAGMA synchronous = NORMAL");
    this.db = drizzle(this.sqlite, { schema });
  }

  migrate(): void {
    for (const migration of MIGRATIONS) {
      const alreadyApplied = this.sqlite
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
        .get() as { 1: number } | undefined;

      if (alreadyApplied) {
        const applied = this.sqlite
          .prepare("SELECT id FROM schema_migrations WHERE id = ?")
          .get(migration.id) as { id: string } | undefined;
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
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  }

  close(): void {
    this.sqlite.close();
  }

  orm(): LocalDrizzleDatabase {
    return this.db;
  }

  getDaemonState(): DaemonStatusRow | null {
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

  upsertDaemonState(input: {
    pid: number | null;
    startedAt: number | null;
    updatedAt: number | null;
    status: string;
    version?: string | null;
    details?: unknown;
  }): void {
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

  listCheckpointSummary(): Array<{
    platform: Platform;
    account_key: string;
    sync_mode: SyncMode;
    last_success_at: number | null;
    last_error_summary: string | null;
  }> {
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
      .all() as Array<{
      platform: Platform;
      account_key: string;
      sync_mode: SyncMode;
      last_success_at: number | null;
      last_error_summary: string | null;
    }>;
  }

  getCheckpoint(platform: Platform, accountKey: string): {
    source_cursor_json: string | null;
    sync_mode: SyncMode;
    raw_ingest_watermark: number;
    projection_watermark: number;
  } | null {
    return this.db
      .select({
        source_cursor_json: syncCheckpoints.sourceCursorJson,
        sync_mode: syncCheckpoints.syncMode,
        raw_ingest_watermark: syncCheckpoints.rawIngestWatermark,
        projection_watermark: syncCheckpoints.projectionWatermark,
      })
      .from(syncCheckpoints)
      .where(and(eq(syncCheckpoints.platform, platform), eq(syncCheckpoints.accountKey, accountKey)))
      .get() as {
      source_cursor_json: string | null;
      sync_mode: SyncMode;
      raw_ingest_watermark: number;
      projection_watermark: number;
    } | undefined ?? null;
  }

  resetSource(platform: Platform): number {
    return this.db.transaction((tx) => {
      const removedRuns = tx.delete(syncRuns).where(eq(syncRuns.platform, platform)).run().changes;
      const removedErrors = tx.delete(syncRunErrors).where(eq(syncRunErrors.platform, platform)).run().changes;
      const removedCheckpoints = tx.delete(syncCheckpoints).where(eq(syncCheckpoints.platform, platform)).run().changes;
      return Number(removedRuns) + Number(removedErrors) + Number(removedCheckpoints);
    });
  }

  insertMergeDecision(input: {
    decisionType: MergeDecisionType;
    leftContactId?: string | null;
    rightContactId?: string | null;
    canonicalContactId?: string | null;
    reason?: string | null;
    createdBy: string;
  }): string {
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

  getOverview(): {
    contacts: number;
    conversations: number;
    messages: number;
    rawEvents: number;
    sourceAccounts: number;
    integrations: number;
    authSessions: number;
  } {
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

  listIntegrationStates(): IntegrationStateRow[] {
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
      .all() as IntegrationStateRow[];
  }

  listEnabledSyncPlatforms(): Platform[] {
    return this.db
      .selectDistinct({ platform: integrationStates.platform })
      .from(integrationStates)
      .where(and(eq(integrationStates.enabled, 1), eq(integrationStates.syncCapable, 1)))
      .orderBy(asc(integrationStates.platform))
      .all()
      .map((row) => row.platform as Platform);
  }

  listEnabledSyncTargets(): Array<{ platform: Platform; account_key: string }> {
    return this.db
      .select({
        platform: integrationStates.platform,
        account_key: integrationStates.accountKey,
      })
      .from(integrationStates)
      .where(and(eq(integrationStates.enabled, 1), eq(integrationStates.syncCapable, 1)))
      .orderBy(asc(integrationStates.platform), asc(integrationStates.accountKey))
      .all() as Array<{ platform: Platform; account_key: string }>;
  }

  getIntegrationState(platform: Platform, accountKey: string): IntegrationStateRow | null {
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
      .get() as IntegrationStateRow | undefined ?? null;
  }

  upsertIntegrationState(input: {
    platform: Platform;
    accountKey: string;
    displayName?: string | null;
    authState: IntegrationAuthState;
    enabled?: boolean;
    connectionKind: ConnectionKind;
    syncCapable?: boolean;
    launchStrategy?: IntegrationLaunchStrategy | null;
    launchTarget?: string | null;
    importedFrom?: string | null;
    artifactPaths?: string[];
    metadata?: unknown;
  }): void {
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

  setIntegrationEnabled(platform: Platform, accountKey: string, enabled: boolean): void {
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

  listAuthSessions(limit = 20): AuthSessionRow[] {
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
      .all() as AuthSessionRow[];
  }

  getAuthSession(sessionId: string): AuthSessionRow | null {
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
      .get() as AuthSessionRow | undefined ?? null;
  }

  getLatestAuthSession(platform: Platform, accountKey: string): AuthSessionRow | null {
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
      .get() as AuthSessionRow | undefined ?? null;
  }

  createAuthSession(input: {
    id?: string;
    platform: Platform;
    accountKey: string;
    integrationStateId: string;
    state?: AuthSessionState;
    requestedAt?: number;
    resultSummary?: unknown;
    errorSummary?: string | null;
  }): string {
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

  updateAuthSessionState(input: {
    id: string;
    state: AuthSessionState;
    nativePid?: number | null;
    startedAt?: number | null;
    finishedAt?: number | null;
    keychainService?: string | null;
    keychainAccount?: string | null;
    resultSummary?: unknown;
    errorSummary?: string | null;
  }): void {
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

  queueSyncRun(input: {
    platform?: Platform | null;
    accountKey?: string | null;
    runType: SyncRunType;
    trigger: string;
    details?: unknown;
  }): string {
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

  hasQueuedOrRunningRun(platform: Platform, accountKey?: string | null): boolean {
    const accountPredicate = accountKey == null
      ? sql`1 = 1`
      : eq(syncRuns.accountKey, accountKey);
    return Boolean(
      this.db
        .select({ id: syncRuns.id })
        .from(syncRuns)
        .where(and(
          eq(syncRuns.platform, platform),
          accountPredicate,
          inArray(syncRuns.status, ["queued", "running"]),
        ))
        .limit(1)
        .get(),
    );
  }

  listCheckpointPlatforms(): string[] {
    return this.db
      .selectDistinct({ platform: syncCheckpoints.platform })
      .from(syncCheckpoints)
      .orderBy(asc(syncCheckpoints.platform))
      .all()
      .map((row) => row.platform);
  }

  listCheckpointTargets(): Array<{ platform: Platform; account_key: string }> {
    return this.db
      .select({
        platform: syncCheckpoints.platform,
        account_key: syncCheckpoints.accountKey,
      })
      .from(syncCheckpoints)
      .orderBy(asc(syncCheckpoints.platform), asc(syncCheckpoints.accountKey))
      .all() as Array<{ platform: Platform; account_key: string }>;
  }

  listRecentRuns(limit = 10): Array<{
    id: string;
    platform: Platform | null;
    account_key: string | null;
    run_type: SyncRunType;
    status: SyncRunStatus;
    trigger: string;
    started_at: number;
    finished_at: number | null;
  }> {
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
      .all() as Array<{
      id: string;
      platform: Platform | null;
      account_key: string | null;
      run_type: SyncRunType;
      status: SyncRunStatus;
      trigger: string;
      started_at: number;
      finished_at: number | null;
    }>;
  }

  claimNextQueuedRun(): QueuedSyncRun | null {
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
        .get() as {
        id: string;
        platform: Platform | null;
        account_key: string | null;
        run_type: SyncRunType;
        status: SyncRunStatus;
        trigger: string;
        started_at: number;
        details_json: string | null;
      } | undefined;

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

  finishRun(runId: string, details?: unknown): void {
    const values: {
      status: SyncRunStatus;
      finishedAt: number;
      detailsJson?: string;
    } = details === undefined
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

  failRun(runId: string, errorMessage: string, details?: unknown): void {
    this.db.transaction((tx) => {
      const values: {
        status: SyncRunStatus;
        finishedAt: number;
        detailsJson?: string;
      } = details === undefined
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

  upsertSourceAccount(input: {
    platform: Platform;
    accountKey: string;
    displayName?: string | null;
    status?: string;
    metadata?: unknown;
  }): void {
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

  upsertCheckpoint(input: {
    platform: Platform;
    accountKey: string;
    syncMode: SyncMode;
    sourceCursor?: unknown;
    rawIngestWatermark?: number;
    projectionWatermark?: number;
    lastSuccessAt?: number | null;
    lastErrorSummary?: string | null;
  }): void {
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
            : sql`${syncCheckpoints.lastFullSyncAt}`,
          lastSuccessAt: values.lastSuccessAt,
          lastErrorSummary: values.lastErrorSummary,
          updatedAt: values.updatedAt,
        },
      })
      .run();
  }

  insertRawEvent(event: RawEventInput): boolean {
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

  listRawEvents(): Array<{
    id: string;
    platform: Platform;
    account_key: string;
    entity_kind: RawEventEntityKind;
    event_kind: string;
    observed_at: number;
    payload_json: string;
  }> {
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
      .all() as Array<{
      id: string;
      platform: Platform;
      account_key: string;
      entity_kind: RawEventEntityKind;
      event_kind: string;
      observed_at: number;
      payload_json: string;
    }>;
  }

  clearProjectedState(): void {
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

  private countRows(table: SQLiteTable): number {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(table)
      .get();

    return Number(row?.count ?? 0);
  }
}

export function openCuedDatabase(dbPath?: string): CuedDatabase {
  const db = new CuedDatabase(dbPath);
  db.migrate();
  return db;
}
