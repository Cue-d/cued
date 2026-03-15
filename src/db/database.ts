import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { getCurrentAppVersion, getCurrentReleaseChannel } from "../app-metadata.js";
import { CUED_DB_PATH, ensureCuedDirs } from "../config.js";
import { normalizePhone } from "../lib/phone.js";
import type {
  AuthSessionState,
  ConnectionKind,
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
import type {
  PendingRollbackState,
  UpdateErrorState,
  UpdateReleaseState,
  UpdateStatusSnapshot,
} from "../updater/types.js";
import { safeParseJson, safeStringifyJson } from "./codecs.js";
import { MIGRATIONS } from "./migrations.js";
import * as schema from "./schema.js";

const {
  appSettings,
  authSessions,
  contactMergeDecisions,
  contactHandles,
  contactSources,
  contacts,
  conversationParticipants,
  conversations,
  daemonState,
  integrationStates,
  messageAttachments,
  messageReactions,
  messages,
  outboundMessages,
  projectionState,
  rawEvents,
  sourceAccounts,
  syncCheckpoints,
  syncRunErrors,
  syncRuns,
  timelineEvents,
} = schema;

const APP_SETTING_KEYS = {
  cliSymlinkInstalled: "cli_symlink_installed",
  installedAppVersion: "installed_app_version",
  lastReleaseCheckAt: "last_release_check_at",
  onboardingCompletedVersion: "onboarding_completed_version",
  releaseChannel: "release_channel",
  updateLastError: "update_last_error_json",
  updatePendingRollback: "update_pending_rollback_json",
  updateReleaseState: "update_release_state_json",
} as const;

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
  queued_at: number;
  started_at: number | null;
  details_json: string | null;
}

export interface ProjectionStateRow {
  singleton_key: "global";
  projection_watermark: number;
  last_projected_at: number | null;
  last_rebuild_at: number | null;
  updated_at: number;
}

export interface AppSettingRow {
  key: string;
  value: string | null;
  updated_at: number;
}

export interface AppMetadataSnapshot {
  onboardingCompletedVersion: string | null;
  releaseChannel: string | null;
  installedAppVersion: string | null;
  lastReleaseCheckAt: number | null;
  cliSymlinkInstalled: boolean;
  updateReleaseState: UpdateReleaseState | null;
  updatePendingRollback: PendingRollbackState | null;
  updateLastError: UpdateErrorState | null;
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

export interface OutboundMessageRow {
  id: string;
  platform: Platform;
  account_key: string;
  target: string;
  thread_id: string | null;
  text: string;
  status: string;
  attempt_count: number;
  scheduled_for: number;
  started_at: number | null;
  finished_at: number | null;
  last_error: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface SignalSendResolution {
  target: string;
  threadId: string;
  resolution: "group" | "signal_id" | "signal_phone" | "phone" | "imessage_phone" | "passthrough";
  matchedContactIds: string[];
  matchedName: string | null;
}

export interface WhatsAppSendResolution {
  target: string;
  threadId: string;
  resolution: "whatsapp_jid" | "phone" | "group" | "passthrough";
  matchedContactIds: string[];
  matchedName: string | null;
}

type SignalSendCandidate = {
  rank: number;
  target: string;
  resolution: Extract<
    SignalSendResolution["resolution"],
    "signal_id" | "signal_phone" | "phone" | "imessage_phone"
  >;
};

type WhatsAppSendCandidate = {
  rank: number;
  target: string;
  resolution: Extract<WhatsAppSendResolution["resolution"], "whatsapp_jid" | "phone">;
};

const SIGNAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isSignalUuid(value: string): boolean {
  return SIGNAL_UUID_PATTERN.test(value.trim());
}

function normalizeSignalThreadRecipient(
  value: string,
  resolution: SignalSendResolution["resolution"],
): string {
  const trimmed = value.trim();
  if (resolution === "signal_id") {
    return trimmed.toLowerCase();
  }
  const normalizedPhone = normalizePhone(trimmed);
  if (normalizedPhone) {
    return normalizedPhone;
  }
  return trimmed.toLowerCase();
}

function buildSignalDmThreadId(
  recipient: string,
  resolution: SignalSendResolution["resolution"],
): string {
  return `dm:${normalizeSignalThreadRecipient(recipient, resolution)}`;
}

function normalizeSignalHandleLookupValue(value: string): string {
  const trimmed = value.trim();
  const normalizedPhone = normalizePhone(trimmed);
  if (normalizedPhone) {
    return normalizedPhone;
  }
  return trimmed.toLowerCase();
}

function normalizeWhatsAppJid(value: string): string {
  return value.trim().toLowerCase();
}

function buildWhatsAppThreadId(target: string): string {
  const normalized = normalizeWhatsAppJid(target);
  return normalized.endsWith("@g.us") ? `group:${normalized}` : `dm:${normalized}`;
}

function normalizeWhatsAppHandleLookupValue(value: string): string {
  const trimmed = value.trim();
  const normalizedPhone = normalizePhone(trimmed);
  if (normalizedPhone) {
    return normalizedPhone;
  }
  return normalizeWhatsAppJid(trimmed);
}

export type LocalDrizzleDatabase = BetterSQLite3Database<typeof schema>;
const WRITE_BATCH_SIZE = 250;

function now(): number {
  return Date.now();
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export class CuedDatabase {
  private readonly sqlite: Database.Database;
  private readonly db: LocalDrizzleDatabase;

  constructor(
    public readonly dbPath: string = CUED_DB_PATH,
    options: {
      readonly?: boolean;
    } = {},
  ) {
    ensureCuedDirs();
    this.sqlite = new Database(
      dbPath,
      options.readonly ? { readonly: true, fileMustExist: true } : undefined,
    );
    this.sqlite.exec("PRAGMA busy_timeout = 5000");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    if (!options.readonly) {
      this.sqlite.exec("PRAGMA journal_mode = WAL");
      this.sqlite.exec("PRAGMA synchronous = NORMAL");
    }
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

  listAppSettings(): AppSettingRow[] {
    return this.db
      .select({
        key: appSettings.key,
        value: appSettings.value,
        updated_at: appSettings.updatedAt,
      })
      .from(appSettings)
      .orderBy(asc(appSettings.key))
      .all() as AppSettingRow[];
  }

  getAppSetting(key: string): AppSettingRow | null {
    const row = this.db
      .select({
        key: appSettings.key,
        value: appSettings.value,
        updated_at: appSettings.updatedAt,
      })
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .get();

    return row ? (row as AppSettingRow) : null;
  }

  setAppSetting(key: string, value: string | null): void {
    this.db
      .insert(appSettings)
      .values({
        key,
        value,
        updatedAt: now(),
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: {
          value,
          updatedAt: now(),
        },
      })
      .run();
  }

  recordAppMetadata(input: {
    version: string;
    releaseChannel: string;
    cliSymlinkInstalled?: boolean | null;
  }): void {
    this.setAppSetting(APP_SETTING_KEYS.installedAppVersion, input.version);
    this.setAppSetting(APP_SETTING_KEYS.releaseChannel, input.releaseChannel);
    if (typeof input.cliSymlinkInstalled === "boolean") {
      this.setAppSetting(
        APP_SETTING_KEYS.cliSymlinkInstalled,
        input.cliSymlinkInstalled ? "1" : "0",
      );
    }
  }

  markOnboardingCompleted(version: string): void {
    this.setAppSetting(APP_SETTING_KEYS.onboardingCompletedVersion, version);
  }

  markReleaseCheck(at = now()): void {
    this.setAppSetting(APP_SETTING_KEYS.lastReleaseCheckAt, String(at));
  }

  setUpdateReleaseState(value: UpdateReleaseState | null): void {
    this.setAppSetting(APP_SETTING_KEYS.updateReleaseState, safeStringifyJson(value));
    if (value) {
      this.markReleaseCheck(value.checkedAt);
    }
  }

  setUpdatePendingRollback(value: PendingRollbackState | null): void {
    this.setAppSetting(APP_SETTING_KEYS.updatePendingRollback, safeStringifyJson(value));
  }

  setUpdateLastError(value: UpdateErrorState | null): void {
    this.setAppSetting(APP_SETTING_KEYS.updateLastError, safeStringifyJson(value));
  }

  getUpdateReleaseState(): UpdateReleaseState | null {
    return safeParseJson<UpdateReleaseState | null>(
      this.getAppSetting(APP_SETTING_KEYS.updateReleaseState)?.value ?? null,
      "app_settings.update_release_state_json",
      null,
    );
  }

  getPendingRollbackState(): PendingRollbackState | null {
    return safeParseJson<PendingRollbackState | null>(
      this.getAppSetting(APP_SETTING_KEYS.updatePendingRollback)?.value ?? null,
      "app_settings.update_pending_rollback_json",
      null,
    );
  }

  getUpdateLastError(): UpdateErrorState | null {
    const raw = this.getAppSetting(APP_SETTING_KEYS.updateLastError)?.value ?? null;
    const parsed = safeParseJson<UpdateErrorState | null>(
      raw,
      "app_settings.update_last_error_json",
      null,
    );
    if (parsed) {
      return parsed;
    }
    if (!raw) {
      return null;
    }
    return {
      at: now(),
      stage: "unknown",
      message: raw,
      targetVersion: null,
    };
  }

  getUpdateStatus(): UpdateStatusSnapshot {
    const releaseState = this.getUpdateReleaseState();
    return {
      currentVersion: getCurrentAppVersion(),
      releaseChannel: getCurrentReleaseChannel(),
      lastCheckedAt: releaseState?.checkedAt ?? this.getAppMetadata().lastReleaseCheckAt,
      latestVersion: releaseState?.latestVersion ?? null,
      availableVersion: releaseState?.availableVersion ?? null,
      available: Boolean(releaseState?.availableVersion),
      releaseUrl: releaseState?.releaseUrl ?? null,
      tarballUrl: releaseState?.tarballUrl ?? null,
      pendingRollback: this.getPendingRollbackState(),
      lastError: this.getUpdateLastError(),
    };
  }

  getAppMetadata(): AppMetadataSnapshot {
    const byKey = new Map(this.listAppSettings().map((row) => [row.key, row.value]));
    const lastReleaseCheckAt = Number(byKey.get(APP_SETTING_KEYS.lastReleaseCheckAt) ?? "");
    return {
      onboardingCompletedVersion: byKey.get(APP_SETTING_KEYS.onboardingCompletedVersion) ?? null,
      releaseChannel: byKey.get(APP_SETTING_KEYS.releaseChannel) ?? null,
      installedAppVersion: byKey.get(APP_SETTING_KEYS.installedAppVersion) ?? null,
      lastReleaseCheckAt: Number.isFinite(lastReleaseCheckAt) ? lastReleaseCheckAt : null,
      cliSymlinkInstalled: (byKey.get(APP_SETTING_KEYS.cliSymlinkInstalled) ?? "0") === "1",
      updateReleaseState: safeParseJson<UpdateReleaseState | null>(
        byKey.get(APP_SETTING_KEYS.updateReleaseState) ?? null,
        "app_settings.update_release_state_json",
        null,
      ),
      updatePendingRollback: safeParseJson<PendingRollbackState | null>(
        byKey.get(APP_SETTING_KEYS.updatePendingRollback) ?? null,
        "app_settings.update_pending_rollback_json",
        null,
      ),
      updateLastError:
        safeParseJson<UpdateErrorState | null>(
          byKey.get(APP_SETTING_KEYS.updateLastError) ?? null,
          "app_settings.update_last_error_json",
          null,
        ) ??
        (byKey.get(APP_SETTING_KEYS.updateLastError)
          ? {
              at: now(),
              stage: "unknown",
              message: byKey.get(APP_SETTING_KEYS.updateLastError) ?? "",
              targetVersion: null,
            }
          : null),
    };
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
        detailsJson: safeStringifyJson(input.details),
      })
      .onConflictDoUpdate({
        target: daemonState.singletonKey,
        set: {
          pid: input.pid,
          startedAt: input.startedAt,
          updatedAt: input.updatedAt,
          status: input.status,
          version: input.version ?? null,
          detailsJson: safeStringifyJson(input.details),
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

  getCheckpoint(
    platform: Platform,
    accountKey: string,
  ): {
    source_cursor_json: string | null;
    sync_mode: SyncMode;
    raw_ingest_watermark: number;
    projection_watermark: number;
    last_success_at: number | null;
    last_error_summary: string | null;
  } | null {
    return (
      (this.db
        .select({
          source_cursor_json: syncCheckpoints.sourceCursorJson,
          sync_mode: syncCheckpoints.syncMode,
          raw_ingest_watermark: syncCheckpoints.rawIngestWatermark,
          projection_watermark: syncCheckpoints.projectionWatermark,
          last_success_at: syncCheckpoints.lastSuccessAt,
          last_error_summary: syncCheckpoints.lastErrorSummary,
        })
        .from(syncCheckpoints)
        .where(
          and(eq(syncCheckpoints.platform, platform), eq(syncCheckpoints.accountKey, accountKey)),
        )
        .get() as
        | {
            source_cursor_json: string | null;
            sync_mode: SyncMode;
            raw_ingest_watermark: number;
            projection_watermark: number;
            last_success_at: number | null;
            last_error_summary: string | null;
          }
        | undefined) ?? null
    );
  }

  resetSource(platform: Platform): number {
    return this.db.transaction((tx) => {
      const removedRuns = tx.delete(syncRuns).where(eq(syncRuns.platform, platform)).run().changes;
      const removedErrors = tx
        .delete(syncRunErrors)
        .where(eq(syncRunErrors.platform, platform))
        .run().changes;
      const removedCheckpoints = tx
        .delete(syncCheckpoints)
        .where(eq(syncCheckpoints.platform, platform))
        .run().changes;
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
    this.db
      .insert(contactMergeDecisions)
      .values({
        id,
        decisionType: input.decisionType,
        leftContactId: input.leftContactId ?? null,
        rightContactId: input.rightContactId ?? null,
        canonicalContactId: input.canonicalContactId ?? null,
        reason: input.reason ?? null,
        createdBy: input.createdBy,
        createdAt: now(),
      })
      .run();
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

  getProjectionState(): ProjectionStateRow {
    const row = this.db
      .select({
        singleton_key: projectionState.singletonKey,
        projection_watermark: projectionState.projectionWatermark,
        last_projected_at: projectionState.lastProjectedAt,
        last_rebuild_at: projectionState.lastRebuildAt,
        updated_at: projectionState.updatedAt,
      })
      .from(projectionState)
      .where(eq(projectionState.singletonKey, "global"))
      .get();

    if (row) {
      return row as ProjectionStateRow;
    }

    const fallback: ProjectionStateRow = {
      singleton_key: "global",
      projection_watermark: 0,
      last_projected_at: null,
      last_rebuild_at: null,
      updated_at: now(),
    };
    this.upsertProjectionState({
      projectionWatermark: 0,
      lastProjectedAt: null,
      lastRebuildAt: null,
    });
    return fallback;
  }

  upsertProjectionState(input: {
    projectionWatermark: number;
    lastProjectedAt?: number | null;
    lastRebuildAt?: number | null;
  }): void {
    const values = {
      singletonKey: "global" as const,
      projectionWatermark: input.projectionWatermark,
      lastProjectedAt: input.lastProjectedAt ?? null,
      lastRebuildAt: input.lastRebuildAt ?? null,
      updatedAt: now(),
    };

    this.db
      .insert(projectionState)
      .values(values)
      .onConflictDoUpdate({
        target: projectionState.singletonKey,
        set: {
          projectionWatermark: values.projectionWatermark,
          lastProjectedAt: values.lastProjectedAt,
          lastRebuildAt: values.lastRebuildAt,
          updatedAt: values.updatedAt,
        },
      })
      .run();
  }

  getProjectionBacklog(): {
    projection_watermark: number;
    max_raw_event_rowid: number;
    pending_raw_events: number;
  } {
    const state = this.getProjectionState();
    const row = this.sqlite
      .prepare(
        `
        SELECT
          COALESCE(MAX(rowid), 0) AS max_raw_event_rowid,
          COALESCE(SUM(CASE WHEN rowid > ? THEN 1 ELSE 0 END), 0) AS pending_raw_events
        FROM raw_events
      `,
      )
      .get(state.projection_watermark) as {
      max_raw_event_rowid: number | null;
      pending_raw_events: number | null;
    };

    return {
      projection_watermark: state.projection_watermark,
      max_raw_event_rowid: Number(row.max_raw_event_rowid ?? 0),
      pending_raw_events: Number(row.pending_raw_events ?? 0),
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
    return (
      (this.db
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
        .where(
          and(
            eq(integrationStates.platform, platform),
            eq(integrationStates.accountKey, accountKey),
          ),
        )
        .get() as IntegrationStateRow | undefined) ?? null
    );
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
      artifactPathsJson: safeStringifyJson(input.artifactPaths),
      metadataJson: safeStringifyJson(input.metadata),
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
      .where(
        and(eq(integrationStates.platform, platform), eq(integrationStates.accountKey, accountKey)),
      )
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
    return (
      (this.db
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
        .get() as AuthSessionRow | undefined) ?? null
    );
  }

  getLatestAuthSession(platform: Platform, accountKey: string): AuthSessionRow | null {
    return (
      (this.db
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
        .get() as AuthSessionRow | undefined) ?? null
    );
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
    this.db
      .insert(authSessions)
      .values({
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
        resultSummaryJson: safeStringifyJson(input.resultSummary),
        errorSummary: input.errorSummary ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
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

    this.db
      .update(authSessions)
      .set({
        state: input.state,
        nativePid: input.nativePid === undefined ? current.native_pid : input.nativePid,
        startedAt: input.startedAt === undefined ? current.started_at : input.startedAt,
        finishedAt: input.finishedAt === undefined ? current.finished_at : input.finishedAt,
        keychainService:
          input.keychainService === undefined ? current.keychain_service : input.keychainService,
        keychainAccount:
          input.keychainAccount === undefined ? current.keychain_account : input.keychainAccount,
        resultSummaryJson:
          input.resultSummary === undefined
            ? current.result_summary_json
            : safeStringifyJson(input.resultSummary),
        errorSummary: input.errorSummary === undefined ? current.error_summary : input.errorSummary,
        updatedAt: now(),
      })
      .where(eq(authSessions.id, input.id))
      .run();
  }

  updateAuthSessionIdentity(input: {
    id: string;
    accountKey: string;
    integrationStateId: string;
  }): void {
    const current = this.getAuthSession(input.id);
    if (!current) {
      throw new Error(`Auth session not found: ${input.id}`);
    }

    this.db
      .update(authSessions)
      .set({
        accountKey: input.accountKey,
        integrationStateId: input.integrationStateId,
        updatedAt: now(),
      })
      .where(eq(authSessions.id, input.id))
      .run();
  }

  deleteIntegrationState(platform: Platform, accountKey: string): void {
    this.db
      .delete(integrationStates)
      .where(
        and(eq(integrationStates.platform, platform), eq(integrationStates.accountKey, accountKey)),
      )
      .run();
  }

  queueOutboundMessage(input: {
    platform: Platform;
    accountKey: string;
    target: string;
    threadId?: string | null;
    text: string;
    metadata?: unknown;
  }): string {
    const id = randomUUID();
    const timestamp = now();
    this.db
      .insert(outboundMessages)
      .values({
        id,
        platform: input.platform,
        accountKey: input.accountKey,
        target: input.target,
        threadId: input.threadId ?? null,
        text: input.text,
        status: "pending",
        attemptCount: 0,
        scheduledFor: timestamp,
        startedAt: null,
        finishedAt: null,
        lastError: null,
        metadataJson: safeStringifyJson(input.metadata),
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    return id;
  }

  resolveSignalSendTarget(targetInput: string): SignalSendResolution | null {
    const trimmed = targetInput.trim();
    if (trimmed.length === 0) {
      return null;
    }

    if (trimmed.startsWith("group:")) {
      return {
        target: trimmed,
        threadId: trimmed,
        resolution: "group",
        matchedContactIds: [],
        matchedName: null,
      };
    }

    const directLookupValue = normalizeSignalHandleLookupValue(trimmed);
    const explicitContact = this.sqlite
      .prepare(
        `
        SELECT id, name
        FROM contacts
        WHERE id = ?
        LIMIT 1
      `,
      )
      .get(trimmed) as { id: string; name: string | null } | undefined;

    const matchingHandleContacts = this.sqlite
      .prepare(
        `
        SELECT DISTINCT c.id, c.name
        FROM contacts c
        JOIN contact_handles h ON h.contact_id = c.id
        WHERE lower(h.value) = lower(?)
           OR lower(h.normalized_value) = lower(?)
        ORDER BY c.updated_at DESC, c.id ASC
      `,
      )
      .all(trimmed, directLookupValue) as Array<{ id: string; name: string | null }>;

    const exactNameContacts = this.sqlite
      .prepare(
        `
        SELECT id, name
        FROM contacts
        WHERE lower(name) = lower(?)
        ORDER BY updated_at DESC, id ASC
      `,
      )
      .all(trimmed) as Array<{ id: string; name: string | null }>;

    const seedContacts = explicitContact
      ? [explicitContact]
      : matchingHandleContacts.length > 0
        ? matchingHandleContacts
        : exactNameContacts;

    const matchedName =
      seedContacts.find(
        (contact) => typeof contact.name === "string" && contact.name.trim().length > 0,
      )?.name ?? null;

    const contactIds = new Set(seedContacts.map((contact) => contact.id));
    if (matchedName) {
      const sameNameContacts = this.sqlite
        .prepare(
          `
          SELECT id
          FROM contacts
          WHERE lower(name) = lower(?)
          ORDER BY updated_at DESC, id ASC
        `,
        )
        .all(matchedName) as Array<{ id: string }>;
      for (const contact of sameNameContacts) {
        contactIds.add(contact.id);
      }
    }

    const candidateContactIds = [...contactIds];
    if (candidateContactIds.length > 0) {
      const placeholders = candidateContactIds.map(() => "?").join(", ");
      const handles = this.sqlite
        .prepare(
          `
          SELECT contact_id, type, value, normalized_value, platform
          FROM contact_handles
          WHERE contact_id IN (${placeholders})
          ORDER BY contact_id ASC, platform ASC, type ASC
        `,
        )
        .all(...candidateContactIds) as Array<{
        contact_id: string;
        type: string;
        value: string;
        normalized_value: string;
        platform: string | null;
      }>;

      const rankedHandle = handles
        .map((handle) => {
          if (handle.platform === "signal" && handle.type === "signal_id") {
            const recipient = handle.normalized_value.trim().toLowerCase();
            return {
              rank: 0,
              target: recipient,
              resolution: "signal_id" as const,
            } satisfies SignalSendCandidate;
          }
          if (handle.platform === "signal" && handle.type === "phone") {
            const recipient =
              normalizePhone(handle.value) || normalizePhone(handle.normalized_value);
            if (!recipient) {
              return null;
            }
            return {
              rank: 1,
              target: recipient,
              resolution: "signal_phone" as const,
            } satisfies SignalSendCandidate;
          }
          if (handle.type === "phone") {
            const recipient =
              normalizePhone(handle.value) || normalizePhone(handle.normalized_value);
            if (!recipient) {
              return null;
            }
            return {
              rank: 2,
              target: recipient,
              resolution: "phone" as const,
            } satisfies SignalSendCandidate;
          }
          if (handle.type === "imessage_handle") {
            const recipient =
              normalizePhone(handle.value) || normalizePhone(handle.normalized_value);
            if (!recipient) {
              return null;
            }
            return {
              rank: 3,
              target: recipient,
              resolution: "imessage_phone" as const,
            } satisfies SignalSendCandidate;
          }
          return null;
        })
        .filter((value): value is SignalSendCandidate => value !== null)
        .sort((left, right) => left.rank - right.rank || left.target.localeCompare(right.target));

      if (rankedHandle[0]) {
        return {
          target: rankedHandle[0].target,
          threadId: buildSignalDmThreadId(rankedHandle[0].target, rankedHandle[0].resolution),
          resolution: rankedHandle[0].resolution,
          matchedContactIds: candidateContactIds,
          matchedName,
        };
      }
    }

    if (isSignalUuid(trimmed)) {
      return {
        target: trimmed.toLowerCase(),
        threadId: buildSignalDmThreadId(trimmed, "signal_id"),
        resolution: "signal_id",
        matchedContactIds: [],
        matchedName: null,
      };
    }

    const directPhone = normalizePhone(trimmed);
    if (directPhone) {
      return {
        target: directPhone,
        threadId: buildSignalDmThreadId(directPhone, "passthrough"),
        resolution: "passthrough",
        matchedContactIds: candidateContactIds,
        matchedName,
      };
    }

    return null;
  }

  resolveWhatsAppSendTarget(targetInput: string): WhatsAppSendResolution | null {
    const trimmed = targetInput.trim();
    if (trimmed.length === 0) {
      return null;
    }

    const normalizedInput = normalizeWhatsAppHandleLookupValue(trimmed);
    const directJid = normalizeWhatsAppJid(trimmed);
    if (directJid.endsWith("@g.us")) {
      return {
        target: directJid,
        threadId: `group:${directJid}`,
        resolution: "group",
        matchedContactIds: [],
        matchedName: null,
      };
    }

    const explicitContact = this.sqlite
      .prepare(
        `
        SELECT id, name
        FROM contacts
        WHERE id = ?
        LIMIT 1
      `,
      )
      .get(trimmed) as { id: string; name: string | null } | undefined;

    const matchingHandleContacts = this.sqlite
      .prepare(
        `
        SELECT DISTINCT c.id, c.name
        FROM contacts c
        JOIN contact_handles h ON h.contact_id = c.id
        WHERE lower(h.value) = lower(?)
           OR lower(h.normalized_value) = lower(?)
        ORDER BY c.updated_at DESC, c.id ASC
      `,
      )
      .all(trimmed, normalizedInput) as Array<{ id: string; name: string | null }>;

    const exactNameContacts = this.sqlite
      .prepare(
        `
        SELECT id, name
        FROM contacts
        WHERE lower(name) = lower(?)
        ORDER BY updated_at DESC, id ASC
      `,
      )
      .all(trimmed) as Array<{ id: string; name: string | null }>;

    const seedContacts = explicitContact
      ? [explicitContact]
      : matchingHandleContacts.length > 0
        ? matchingHandleContacts
        : exactNameContacts;
    const matchedName =
      seedContacts.find(
        (contact) => typeof contact.name === "string" && contact.name.trim().length > 0,
      )?.name ?? null;

    const contactIds = new Set(seedContacts.map((contact) => contact.id));
    if (matchedName) {
      const sameNameContacts = this.sqlite
        .prepare(
          `
          SELECT id
          FROM contacts
          WHERE lower(name) = lower(?)
          ORDER BY updated_at DESC, id ASC
        `,
        )
        .all(matchedName) as Array<{ id: string }>;
      for (const contact of sameNameContacts) {
        contactIds.add(contact.id);
      }
    }

    const candidateContactIds = [...contactIds];
    if (candidateContactIds.length > 0) {
      const placeholders = candidateContactIds.map(() => "?").join(", ");
      const handles = this.sqlite
        .prepare(
          `
          SELECT contact_id, type, value, normalized_value, platform
          FROM contact_handles
          WHERE contact_id IN (${placeholders})
          ORDER BY contact_id ASC, platform ASC, type ASC
        `,
        )
        .all(...candidateContactIds) as Array<{
        contact_id: string;
        type: string;
        value: string;
        normalized_value: string;
        platform: string | null;
      }>;

      const rankedHandle = handles
        .map((handle) => {
          if (handle.platform === "whatsapp" && handle.type === "whatsapp_jid") {
            return {
              rank: 0,
              target: normalizeWhatsAppJid(handle.normalized_value || handle.value),
              resolution: "whatsapp_jid" as const,
            } satisfies WhatsAppSendCandidate;
          }
          if (handle.type === "phone") {
            const recipient =
              normalizePhone(handle.value) || normalizePhone(handle.normalized_value);
            if (!recipient) {
              return null;
            }
            return {
              rank: 1,
              target: `${recipient.slice(1)}@s.whatsapp.net`,
              resolution: "phone" as const,
            } satisfies WhatsAppSendCandidate;
          }
          return null;
        })
        .filter((value): value is WhatsAppSendCandidate => value !== null)
        .sort((left, right) => left.rank - right.rank || left.target.localeCompare(right.target));

      if (rankedHandle[0]) {
        return {
          target: rankedHandle[0].target,
          threadId: buildWhatsAppThreadId(rankedHandle[0].target),
          resolution: rankedHandle[0].resolution,
          matchedContactIds: candidateContactIds,
          matchedName,
        };
      }
    }

    if (directJid.includes("@")) {
      return {
        target: directJid,
        threadId: buildWhatsAppThreadId(directJid),
        resolution: directJid.endsWith("@g.us") ? "group" : "passthrough",
        matchedContactIds: candidateContactIds,
        matchedName,
      };
    }

    const directPhone = normalizePhone(trimmed);
    if (directPhone) {
      const jid = `${directPhone.slice(1)}@s.whatsapp.net`;
      return {
        target: jid,
        threadId: buildWhatsAppThreadId(jid),
        resolution: "passthrough",
        matchedContactIds: candidateContactIds,
        matchedName,
      };
    }

    return null;
  }

  findMessageByPlatformKey(
    platform: Platform,
    accountKey: string,
    platformMessageId: string,
  ): {
    id: string;
    sender_source_key: string | null;
    sent_at: number | null;
    content: string | null;
    status: string | null;
    delivered_at: number | null;
    read_at: number | null;
  } | null {
    return (
      (this.sqlite
        .prepare(
          `
        SELECT
          id,
          sender_source_key,
          sent_at,
          content,
          status,
          delivered_at,
          read_at
        FROM messages
        WHERE platform = ?
          AND account_key = ?
          AND platform_message_id = ?
        LIMIT 1
      `,
        )
        .get(platform, accountKey, platformMessageId) as
        | {
            id: string;
            sender_source_key: string | null;
            sent_at: number | null;
            content: string | null;
            status: string | null;
            delivered_at: number | null;
            read_at: number | null;
          }
        | undefined) ?? null
    );
  }

  claimNextOutboundMessage(platform?: Platform): OutboundMessageRow | null {
    return this.db.transaction((tx) => {
      const whereCondition = platform
        ? and(
            eq(outboundMessages.status, "pending"),
            eq(outboundMessages.platform, platform),
            sql`${outboundMessages.scheduledFor} <= ${now()}`,
          )
        : and(
            eq(outboundMessages.status, "pending"),
            sql`${outboundMessages.scheduledFor} <= ${now()}`,
          );

      const row = tx
        .select({
          id: outboundMessages.id,
          platform: outboundMessages.platform,
          account_key: outboundMessages.accountKey,
          target: outboundMessages.target,
          thread_id: outboundMessages.threadId,
          text: outboundMessages.text,
          status: outboundMessages.status,
          attempt_count: outboundMessages.attemptCount,
          scheduled_for: outboundMessages.scheduledFor,
          started_at: outboundMessages.startedAt,
          finished_at: outboundMessages.finishedAt,
          last_error: outboundMessages.lastError,
          metadata_json: outboundMessages.metadataJson,
          created_at: outboundMessages.createdAt,
          updated_at: outboundMessages.updatedAt,
        })
        .from(outboundMessages)
        .where(whereCondition)
        .orderBy(asc(outboundMessages.scheduledFor), asc(outboundMessages.createdAt))
        .limit(1)
        .get() as OutboundMessageRow | undefined;

      if (!row) {
        return null;
      }

      tx.update(outboundMessages)
        .set({
          status: "sending",
          attemptCount: row.attempt_count + 1,
          startedAt: now(),
          updatedAt: now(),
        })
        .where(eq(outboundMessages.id, row.id))
        .run();

      return {
        ...row,
        status: "sending",
        attempt_count: row.attempt_count + 1,
        started_at: now(),
        updated_at: now(),
      };
    });
  }

  completeOutboundMessage(id: string): void {
    this.db
      .update(outboundMessages)
      .set({
        status: "sent",
        finishedAt: now(),
        updatedAt: now(),
        lastError: null,
      })
      .where(eq(outboundMessages.id, id))
      .run();
  }

  failOutboundMessage(input: {
    id: string;
    retryable: boolean;
    error: string;
    retryDelayMs?: number;
    maxAttempts?: number;
  }): void {
    const current = this.db
      .select({
        attempt_count: outboundMessages.attemptCount,
      })
      .from(outboundMessages)
      .where(eq(outboundMessages.id, input.id))
      .get() as { attempt_count: number } | undefined;

    if (!current) {
      throw new Error(`Outbound message not found: ${input.id}`);
    }

    const shouldRetry = input.retryable && current.attempt_count < (input.maxAttempts ?? 3);
    this.db
      .update(outboundMessages)
      .set({
        status: shouldRetry ? "pending" : "failed",
        scheduledFor: shouldRetry ? now() + (input.retryDelayMs ?? 5_000) : now(),
        finishedAt: shouldRetry ? null : now(),
        updatedAt: now(),
        lastError: input.error,
      })
      .where(eq(outboundMessages.id, input.id))
      .run();
  }

  hasQueuedOutboundMessages(platform?: Platform): boolean {
    const whereCondition = platform
      ? and(eq(outboundMessages.status, "pending"), eq(outboundMessages.platform, platform))
      : eq(outboundMessages.status, "pending");
    const row = this.db
      .select({ id: outboundMessages.id })
      .from(outboundMessages)
      .where(whereCondition)
      .limit(1)
      .get();
    return Boolean(row);
  }

  failInProgressRuns(errorMessage: string): number {
    return this.db.transaction((tx) => {
      const stuckRuns = tx
        .select({
          id: syncRuns.id,
        })
        .from(syncRuns)
        .where(sql`${syncRuns.status} IN ('ingesting', 'projecting')`)
        .all();

      if (stuckRuns.length === 0) {
        return 0;
      }

      const finishedAt = now();
      for (const run of stuckRuns) {
        tx.update(syncRuns)
          .set({
            status: "failed",
            finishedAt,
          })
          .where(eq(syncRuns.id, run.id))
          .run();

        tx.insert(syncRunErrors)
          .values({
            id: randomUUID(),
            syncRunId: run.id,
            errorMessage,
            detailsJson: null,
            createdAt: finishedAt,
          })
          .run();
      }

      return stuckRuns.length;
    });
  }

  queueSyncRun(input: {
    platform?: Platform | null;
    accountKey?: string | null;
    runType: SyncRunType;
    trigger: string;
    details?: unknown;
  }): string {
    const id = randomUUID();
    const queuedAt = now();
    this.db
      .insert(syncRuns)
      .values({
        id,
        platform: input.platform ?? null,
        accountKey: input.accountKey ?? null,
        runType: input.runType,
        status: "queued",
        trigger: input.trigger,
        queuedAt,
        startedAt: null,
        finishedAt: null,
        detailsJson: safeStringifyJson(input.details),
      })
      .run();
    return id;
  }

  queueSyncRuns(
    inputs: Array<{
      platform?: Platform | null;
      accountKey?: string | null;
      runType: SyncRunType;
      trigger: string;
      details?: unknown;
    }>,
  ): string[] {
    if (inputs.length === 0) {
      return [];
    }

    const queuedAt = now();
    const runIds: string[] = [];
    this.db.transaction((tx) => {
      for (const chunk of chunkArray(inputs, WRITE_BATCH_SIZE)) {
        const rows = chunk.map((input) => {
          const id = randomUUID();
          runIds.push(id);
          return {
            id,
            platform: input.platform ?? null,
            accountKey: input.accountKey ?? null,
            runType: input.runType,
            status: "queued" as const,
            trigger: input.trigger,
            queuedAt,
            startedAt: null,
            finishedAt: null,
            detailsJson: safeStringifyJson(input.details),
          };
        });

        tx.insert(syncRuns).values(rows).run();
      }
    });

    return runIds;
  }

  hasQueuedOrRunningRun(platform: Platform, accountKey?: string | null): boolean {
    const accountPredicate = accountKey == null ? sql`1 = 1` : eq(syncRuns.accountKey, accountKey);
    return Boolean(
      this.db
        .select({ id: syncRuns.id })
        .from(syncRuns)
        .where(
          and(
            eq(syncRuns.platform, platform),
            accountPredicate,
            sql`${syncRuns.status} IN ('queued', 'ingesting')`,
          ),
        )
        .limit(1)
        .get(),
    );
  }

  hasQueuedOrActiveProjectionRun(): boolean {
    return Boolean(
      this.db
        .select({ id: syncRuns.id })
        .from(syncRuns)
        .where(
          and(
            inArray(syncRuns.runType, ["project", "rebuild"]),
            sql`${syncRuns.status} IN ('queued', 'projecting')`,
          ),
        )
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
    queued_at: number;
    started_at: number | null;
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
        queued_at: syncRuns.queuedAt,
        started_at: syncRuns.startedAt,
        finished_at: syncRuns.finishedAt,
      })
      .from(syncRuns)
      .orderBy(desc(syncRuns.queuedAt))
      .limit(limit)
      .all() as Array<{
      id: string;
      platform: Platform | null;
      account_key: string | null;
      run_type: SyncRunType;
      status: SyncRunStatus;
      trigger: string;
      queued_at: number;
      started_at: number | null;
      finished_at: number | null;
    }>;
  }

  claimNextQueuedRun(
    runTypes?: SyncRunType[],
    nextStatus: SyncRunStatus = "ingesting",
  ): QueuedSyncRun | null {
    return this.db.transaction((tx) => {
      const statusPredicate =
        runTypes && runTypes.length > 0
          ? and(eq(syncRuns.status, "queued"), inArray(syncRuns.runType, runTypes))
          : eq(syncRuns.status, "queued");

      const row = tx
        .select({
          id: syncRuns.id,
          platform: syncRuns.platform,
          account_key: syncRuns.accountKey,
          run_type: syncRuns.runType,
          status: syncRuns.status,
          trigger: syncRuns.trigger,
          queued_at: syncRuns.queuedAt,
          started_at: syncRuns.startedAt,
          details_json: syncRuns.detailsJson,
        })
        .from(syncRuns)
        .where(statusPredicate)
        .orderBy(asc(syncRuns.queuedAt))
        .limit(1)
        .get() as
        | {
            id: string;
            platform: Platform | null;
            account_key: string | null;
            run_type: SyncRunType;
            status: SyncRunStatus;
            trigger: string;
            queued_at: number;
            started_at: number | null;
            details_json: string | null;
          }
        | undefined;

      if (!row) {
        return null;
      }

      const startedAt = now();
      tx.update(syncRuns)
        .set({ status: nextStatus, startedAt })
        .where(eq(syncRuns.id, row.id))
        .run();

      return { ...row, status: nextStatus, started_at: startedAt };
    });
  }

  updateRunStatus(runId: string, status: SyncRunStatus, details?: unknown): void {
    const values: {
      status: SyncRunStatus;
      detailsJson?: string | null;
    } =
      details === undefined
        ? { status }
        : {
            status,
            detailsJson: safeStringifyJson(details),
          };

    this.db.update(syncRuns).set(values).where(eq(syncRuns.id, runId)).run();
  }

  finishRun(runId: string, details?: unknown): void {
    const values: {
      status: SyncRunStatus;
      finishedAt: number;
      detailsJson?: string | null;
    } =
      details === undefined
        ? {
            status: "completed",
            finishedAt: now(),
          }
        : {
            status: "completed",
            finishedAt: now(),
            detailsJson: safeStringifyJson(details),
          };

    this.db.update(syncRuns).set(values).where(eq(syncRuns.id, runId)).run();
  }

  failRun(runId: string, errorMessage: string, details?: unknown): void {
    this.db.transaction((tx) => {
      const run = tx
        .select({
          platform: syncRuns.platform,
          accountKey: syncRuns.accountKey,
        })
        .from(syncRuns)
        .where(eq(syncRuns.id, runId))
        .get();
      const values: {
        status: SyncRunStatus;
        finishedAt: number;
        detailsJson?: string | null;
      } =
        details === undefined
          ? {
              status: "failed",
              finishedAt: now(),
            }
          : {
              status: "failed",
              finishedAt: now(),
              detailsJson: safeStringifyJson(details),
            };

      tx.update(syncRuns).set(values).where(eq(syncRuns.id, runId)).run();

      tx.insert(syncRunErrors)
        .values({
          id: randomUUID(),
          syncRunId: runId,
          platform: run?.platform ?? null,
          accountKey: run?.accountKey ?? null,
          errorMessage,
          detailsJson: safeStringifyJson(details),
          createdAt: now(),
        })
        .run();
    });
  }

  getLatestSyncRunError(
    platform: Platform,
    accountKey: string,
  ): {
    sync_run_id: string;
    error_message: string;
    created_at: number;
    details_json: string | null;
  } | null {
    return (
      (this.db
        .select({
          sync_run_id: syncRunErrors.syncRunId,
          error_message: syncRunErrors.errorMessage,
          created_at: syncRunErrors.createdAt,
          details_json: syncRunErrors.detailsJson,
        })
        .from(syncRunErrors)
        .where(and(eq(syncRunErrors.platform, platform), eq(syncRunErrors.accountKey, accountKey)))
        .orderBy(desc(syncRunErrors.createdAt))
        .limit(1)
        .get() as
        | {
            sync_run_id: string;
            error_message: string;
            created_at: number;
            details_json: string | null;
          }
        | undefined) ?? null
    );
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
      metadataJson: safeStringifyJson(input.metadata),
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

  upsertSourceAccounts(
    inputs: Array<{
      platform: Platform;
      accountKey: string;
      displayName?: string | null;
      status?: string;
      metadata?: unknown;
    }>,
  ): void {
    if (inputs.length === 0) {
      return;
    }

    const timestamp = now();
    this.db.transaction((tx) => {
      for (const chunk of chunkArray(inputs, WRITE_BATCH_SIZE)) {
        tx.insert(sourceAccounts)
          .values(
            chunk.map((input) => ({
              id: `${input.platform}:${input.accountKey}`,
              platform: input.platform,
              accountKey: input.accountKey,
              displayName: input.displayName ?? null,
              status: input.status ?? "active",
              metadataJson: safeStringifyJson(input.metadata),
              createdAt: timestamp,
              updatedAt: timestamp,
            })),
          )
          .onConflictDoUpdate({
            target: [sourceAccounts.platform, sourceAccounts.accountKey],
            set: {
              displayName: sql`excluded.display_name`,
              status: sql`excluded.status`,
              metadataJson: sql`excluded.metadata_json`,
              updatedAt: timestamp,
            },
          })
          .run();
      }
    });
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
      sourceCursorJson: safeStringifyJson(input.sourceCursor),
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
          lastFullSyncAt:
            input.syncMode === "full"
              ? values.lastSuccessAt
              : sql`${syncCheckpoints.lastFullSyncAt}`,
          lastSuccessAt: values.lastSuccessAt,
          lastErrorSummary: values.lastErrorSummary,
          updatedAt: values.updatedAt,
        },
      })
      .run();
  }

  recordCheckpointError(platform: Platform, accountKey: string, errorSummary: string): void {
    this.db
      .update(syncCheckpoints)
      .set({
        lastErrorAt: now(),
        lastErrorSummary: errorSummary,
        updatedAt: now(),
      })
      .where(
        and(eq(syncCheckpoints.platform, platform), eq(syncCheckpoints.accountKey, accountKey)),
      )
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
        cursorJson: safeStringifyJson(event.cursor),
        dedupeKey: event.dedupeKey,
        payloadJson: safeStringifyJson(event.payload) ?? "null",
        sourceVersion: event.sourceVersion ?? null,
      })
      .onConflictDoNothing()
      .run();
    return Number(result.changes) > 0;
  }

  insertRawEvents(events: RawEventInput[]): {
    insertedCount: number;
    insertedEvents: RawEventInput[];
    insertedRows: Array<{ rowId: number; event: RawEventInput }>;
    firstInsertedRowId: number | null;
    lastInsertedRowId: number | null;
  } {
    if (events.length === 0) {
      return {
        insertedCount: 0,
        insertedEvents: [],
        insertedRows: [],
        firstInsertedRowId: null,
        lastInsertedRowId: null,
      };
    }

    const uniqueEvents = [...new Map(events.map((event) => [event.id, event])).values()];
    const existingIds = new Set<string>();
    this.db.transaction((tx) => {
      for (const chunk of chunkArray(uniqueEvents, WRITE_BATCH_SIZE)) {
        const rows = tx
          .select({ id: rawEvents.id })
          .from(rawEvents)
          .where(
            inArray(
              rawEvents.id,
              chunk.map((event) => event.id),
            ),
          )
          .all();
        for (const row of rows) {
          existingIds.add(row.id);
        }
      }

      for (const chunk of chunkArray(uniqueEvents, WRITE_BATCH_SIZE)) {
        tx.insert(rawEvents)
          .values(
            chunk.map((event) => ({
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
              cursorJson: safeStringifyJson(event.cursor),
              dedupeKey: event.dedupeKey,
              payloadJson: safeStringifyJson(event.payload) ?? "null",
              sourceVersion: event.sourceVersion ?? null,
            })),
          )
          .onConflictDoNothing()
          .run();
      }
    });

    const insertedRowIds = new Map<string, number>();
    let firstInsertedRowId: number | null = null;
    let lastInsertedRowId: number | null = null;
    const candidateEvents = uniqueEvents.filter((event) => !existingIds.has(event.id));
    if (candidateEvents.length > 0) {
      for (const chunk of chunkArray(candidateEvents, WRITE_BATCH_SIZE)) {
        const rows = this.sqlite
          .prepare(
            `
            SELECT id, rowid
            FROM raw_events
            WHERE id IN (${chunk.map(() => "?").join(", ")})
            ORDER BY rowid ASC
          `,
          )
          .all(...chunk.map((event) => event.id)) as Array<{ id: string; rowid: number }>;
        if (rows.length === 0) {
          continue;
        }

        for (const row of rows) {
          insertedRowIds.set(row.id, row.rowid);
        }

        if (firstInsertedRowId == null || rows[0]!.rowid < firstInsertedRowId) {
          firstInsertedRowId = rows[0]!.rowid;
        }
        const chunkLastRowId = rows[rows.length - 1]!.rowid;
        if (lastInsertedRowId == null || chunkLastRowId > lastInsertedRowId) {
          lastInsertedRowId = chunkLastRowId;
        }
      }
    }
    const insertedEvents = candidateEvents.filter((event) => insertedRowIds.has(event.id));
    const insertedRows = insertedEvents
      .map((event) => {
        const rowId = insertedRowIds.get(event.id);
        return rowId == null ? null : { rowId, event };
      })
      .filter((value): value is { rowId: number; event: RawEventInput } => value !== null);
    return {
      insertedCount: insertedEvents.length,
      insertedEvents,
      insertedRows,
      firstInsertedRowId,
      lastInsertedRowId,
    };
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

  listRawEventsAfter(
    rowId: number,
    limit?: number,
  ): Array<{
    rowid: number;
    id: string;
    platform: Platform;
    account_key: string;
    entity_kind: RawEventEntityKind;
    event_kind: string;
    observed_at: number;
    payload_json: string;
  }> {
    return this.sqlite
      .prepare(
        `
        SELECT
          rowid,
          id,
          platform,
          account_key,
          entity_kind,
          event_kind,
          observed_at,
          payload_json
        FROM raw_events
        WHERE rowid > ?
        ORDER BY rowid ASC
        LIMIT ?
      `,
      )
      .all(rowId, limit ?? Number.MAX_SAFE_INTEGER) as Array<{
      rowid: number;
      id: string;
      platform: Platform;
      account_key: string;
      entity_kind: RawEventEntityKind;
      event_kind: string;
      observed_at: number;
      payload_json: string;
    }>;
  }

  getRawEventRowIdRange(
    platform: Platform,
    accountKey?: string,
  ): { minRowId: number; maxRowId: number } | null {
    const clauses = ["platform = ?"];
    const params: Array<string> = [platform];
    if (accountKey) {
      clauses.push("account_key = ?");
      params.push(accountKey);
    }

    const row = this.sqlite
      .prepare(
        `
        SELECT MIN(rowid) AS min_rowid, MAX(rowid) AS max_rowid
        FROM raw_events
        WHERE ${clauses.join(" AND ")}
      `,
      )
      .get(...params) as { min_rowid: number | null; max_rowid: number | null } | undefined;

    if (!row?.min_rowid || !row?.max_rowid) {
      return null;
    }

    return {
      minRowId: row.min_rowid,
      maxRowId: row.max_rowid,
    };
  }

  listRawEventsInRange(
    startRowId: number,
    endRowId: number,
    limit?: number,
  ): Array<{
    rowid: number;
    id: string;
    platform: Platform;
    account_key: string;
    entity_kind: RawEventEntityKind;
    event_kind: string;
    observed_at: number;
    payload_json: string;
  }> {
    if (endRowId < startRowId) {
      return [];
    }

    return this.sqlite
      .prepare(
        `
        SELECT
          rowid,
          id,
          platform,
          account_key,
          entity_kind,
          event_kind,
          observed_at,
          payload_json
        FROM raw_events
        WHERE rowid >= ?
          AND rowid <= ?
        ORDER BY rowid ASC
        LIMIT ?
      `,
      )
      .all(startRowId, endRowId, limit ?? Number.MAX_SAFE_INTEGER) as Array<{
      rowid: number;
      id: string;
      platform: Platform;
      account_key: string;
      entity_kind: RawEventEntityKind;
      event_kind: string;
      observed_at: number;
      payload_json: string;
    }>;
  }

  getQueuedProjectionRun(): QueuedSyncRun | null {
    return (
      (this.db
        .select({
          id: syncRuns.id,
          platform: syncRuns.platform,
          account_key: syncRuns.accountKey,
          run_type: syncRuns.runType,
          status: syncRuns.status,
          trigger: syncRuns.trigger,
          queued_at: syncRuns.queuedAt,
          started_at: syncRuns.startedAt,
          details_json: syncRuns.detailsJson,
        })
        .from(syncRuns)
        .where(and(eq(syncRuns.status, "queued"), eq(syncRuns.runType, "project")))
        .orderBy(asc(syncRuns.queuedAt))
        .limit(1)
        .get() as QueuedSyncRun | undefined) ?? null
    );
  }

  updateRunDetails(runId: string, details: unknown): void {
    this.db
      .update(syncRuns)
      .set({
        detailsJson: safeStringifyJson(details),
      })
      .where(eq(syncRuns.id, runId))
      .run();
  }

  listProjectedContactSourceMap(): Array<{
    platform: Platform;
    account_key: string;
    source_entity_key: string;
    contact_id: string;
  }> {
    return this.db
      .select({
        platform: contactSources.platform,
        account_key: contactSources.accountKey,
        source_entity_key: contactSources.sourceEntityKey,
        contact_id: contactSources.contactId,
      })
      .from(contactSources)
      .all() as Array<{
      platform: Platform;
      account_key: string;
      source_entity_key: string;
      contact_id: string;
    }>;
  }

  listDeterministicContactHandles(): Array<{
    handle_type: string;
    normalized_value: string;
    contact_id: string;
  }> {
    return this.db
      .select({
        handle_type: contactHandles.type,
        normalized_value: contactHandles.normalizedValue,
        contact_id: contactHandles.contactId,
      })
      .from(contactHandles)
      .where(eq(contactHandles.isDeterministic, 1))
      .all() as Array<{
      handle_type: string;
      normalized_value: string;
      contact_id: string;
    }>;
  }

  listConversationMap(): Array<{
    platform: Platform;
    account_key: string;
    source_conversation_key: string;
    conversation_id: string;
  }> {
    return this.db
      .select({
        platform: conversations.platform,
        account_key: conversations.accountKey,
        source_conversation_key: conversations.sourceConversationKey,
        conversation_id: conversations.id,
      })
      .from(conversations)
      .all() as Array<{
      platform: Platform;
      account_key: string;
      source_conversation_key: string;
      conversation_id: string;
    }>;
  }

  listContactNames(): Array<{
    contact_id: string;
    name: string | null;
  }> {
    return this.db
      .select({
        contact_id: contacts.id,
        name: contacts.name,
      })
      .from(contacts)
      .all() as Array<{
      contact_id: string;
      name: string | null;
    }>;
  }

  listConversationNames(): Array<{
    conversation_id: string;
    name: string | null;
  }> {
    return this.db
      .select({
        conversation_id: conversations.id,
        name: conversations.name,
      })
      .from(conversations)
      .all() as Array<{
      conversation_id: string;
      name: string | null;
    }>;
  }

  listMessageMap(): Array<{
    platform: Platform;
    account_key: string;
    platform_message_id: string;
    message_id: string;
  }> {
    return this.db
      .select({
        platform: messages.platform,
        account_key: messages.accountKey,
        platform_message_id: messages.platformMessageId,
        message_id: messages.id,
      })
      .from(messages)
      .all() as Array<{
      platform: Platform;
      account_key: string;
      platform_message_id: string;
      message_id: string;
    }>;
  }

  clearProjectedState(): void {
    this.db.transaction((tx) => {
      tx.run(sql.raw("DELETE FROM messages_fts"));
      tx.delete(timelineEvents).run();
      tx.delete(messageAttachments).run();
      tx.delete(messageReactions).run();
      tx.delete(conversationParticipants).run();
      tx.delete(messages).run();
      tx.delete(conversations).run();
      tx.delete(contactHandles).run();
      tx.delete(contactSources).run();
      tx.delete(contacts).run();
    });
  }

  private countRows(table: SQLiteTable): number {
    const row = this.db.select({ count: sql<number>`count(*)` }).from(table).get();

    return Number(row?.count ?? 0);
  }
}

export function openCuedDatabase(dbPath?: string): CuedDatabase {
  const db = new CuedDatabase(dbPath);
  db.migrate();
  db.recordAppMetadata({
    version: getCurrentAppVersion(),
    releaseChannel: getCurrentReleaseChannel(),
  });
  return db;
}

export function openCuedDatabaseReadOnly(dbPath?: string): CuedDatabase {
  if (!existsSync(dbPath ?? CUED_DB_PATH)) {
    return openCuedDatabase(dbPath);
  }

  return new CuedDatabase(dbPath, { readonly: true });
}
