import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type Database from "better-sqlite3-multiple-ciphers";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { getCurrentAppVersion, getCurrentReleaseChannel } from "../core/app-metadata.js";
import { CUED_DB_PATH, ensureCuedDirs } from "../core/config.js";
import type {
  AuthSessionState,
  ConnectionKind,
  IntegrationAuthState,
  IntegrationLaunchStrategy,
  Platform,
  ProviderRawEventInput,
  RawEventEntityKind,
  SourceAccountInput,
  SyncMode,
  SyncProofInput,
  SyncRunStatus,
  SyncRunType,
} from "../core/types/provider.js";
import { parsePlatform, resolveRawEventNormalizedSchema } from "../core/types/provider.js";
import { assertKnownSyncProofKindContract } from "../platforms/core/proofs.js";
import {
  assertCanonicalNormalizedSchemaForWrite,
  assertCanonicalRawEventPayloadForWrite,
} from "../runtime/projection/events.js";
import type {
  PendingRollbackState,
  UpdateErrorState,
  UpdateReleaseState,
  UpdateStatusSnapshot,
} from "../runtime/updater/types.js";
import { safeParseJson, safeStringifyJson } from "./codecs.js";
import { MIGRATIONS } from "./migrations.js";
import * as schema from "./schema.js";
import { openSqliteDatabase } from "./sqlite.js";

const {
  attachmentCache,
  attachmentContent,
  appSettings,
  authSessions,
  contactMergeDecisions,
  contactHandles,
  contactMemories,
  contactSources,
  contacts,
  conversations,
  daemonState,
  integrationStates,
  messageFtsIndexQueue,
  messages,
  projectionState,
  rawEventProjectionFailures,
  rawEvents,
  sourceAccounts,
  syncProofs,
  syncCheckpoints,
  syncRunErrors,
  syncRuns,
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
const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5_000;

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
  scheduled_at: number;
  started_at: number | null;
  attempt: number;
  owner_id: string | null;
  lease_expires_at: number | null;
  details_json: string | null;
}

interface SyncRunClaim {
  ownerId: string | null;
  attempt: number;
}

interface MessageFtsIndexQueueRow {
  message_id: string;
  status: "queued" | "indexing" | "completed" | "failed";
  queued_at: number;
  updated_at: number;
}

interface ContactMemoryRow {
  id: string;
  contact_id: string;
  contact_name: string | null;
  body: string;
  source_kind: string;
  evidence_json: string | null;
  confidence: number | null;
  supersedes_memory_id: string | null;
  stale_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface ContactMergeBatchInput {
  primaryContactId: string;
  secondaryContactId: string;
  reason?: string | null;
}

interface PlannedContactMergeDecision {
  decisionId: string;
  primaryContactId: string;
  secondaryContactId: string;
  canonicalContactId: string;
  reason: string | null;
}

interface ProjectionStateRow {
  singleton_key: "global";
  projection_watermark: number;
  updated_at: number;
}

interface AppSettingRow {
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

interface SyncProofRow {
  scope_kind: string;
  scope_key: string;
  proof_kind: string;
  status: string;
  last_observed_at: number;
  resume_cursor_json: string | null;
  coverage_json: string | null;
  stats_json: string | null;
}

function buildSyncProofId(
  platform: Platform,
  accountKey: string,
  scopeKind: string,
  scopeKey: string,
  proofKind: string,
): string {
  return `proof:${Buffer.from(
    JSON.stringify([platform, accountKey, scopeKind, scopeKey, proofKind]),
  ).toString("base64url")}`;
}

export type RawEventInput = ProviderRawEventInput;

interface WhatsAppHistoryBackfillAnchorRow {
  chatJID: string;
  messageID: string;
  timestamp: number;
  fromMe: boolean;
}

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

function hasKnownPlatform<T extends { platform: string | null }>(
  row: T,
): row is T & { platform: Platform } {
  return typeof row.platform === "string" && parsePlatform(row.platform) !== null;
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

export interface MessageAttachmentRow {
  id: string;
  message_id: string;
  platform: Platform;
  account_key: string;
  source_attachment_key: string;
  kind: string | null;
  mime_type: string | null;
  filename: string | null;
  title: string | null;
  local_path: string | null;
  remote_url: string | null;
  size_bytes: number | null;
  text_content: string | null;
  access_kind: string | null;
  access_ref_json: string | null;
  created_at: number;
  updated_at: number;
  conversation_id?: string;
  platform_message_id?: string;
  sent_at?: number;
  content?: string | null;
  sender_name?: string | null;
  conversation_name?: string | null;
}

export interface AttachmentCacheRow {
  id: string;
  attachment_id: string;
  variant: string;
  status: string;
  cache_path: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  fetched_at: number | null;
  last_accessed_at: number | null;
  expires_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface AttachmentContentRow {
  attachment_id: string;
  extractor: string | null;
  status: string;
  text_content: string | null;
  mime_type: string | null;
  extracted_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export type LocalDrizzleDatabase = BetterSQLite3Database<typeof schema>;
const WRITE_BATCH_SIZE = 250;

function now(): number {
  return Date.now();
}

function resolveCanonicalContactIdFromAliases(
  contactId: string,
  aliasMap: Map<string, string>,
): string {
  const seen = new Set<string>();
  let current = contactId;
  while (!seen.has(current)) {
    seen.add(current);
    const next = aliasMap.get(current);
    if (!next || next === current) {
      return current;
    }
    current = next;
  }
  throw new Error(`Contact merge alias cycle detected at ${current}`);
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function sqlValueList(values: readonly (string | number)[]) {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

function buildRawEventValues(event: RawEventInput) {
  const normalizedSchema = resolveRawEventNormalizedSchema(event);
  assertCanonicalNormalizedSchemaForWrite(normalizedSchema);
  assertCanonicalRawEventPayloadForWrite({ ...event, normalizedSchema });
  return {
    id: event.id,
    platform: event.platform,
    accountKey: event.accountKey,
    entityKind: event.entityKind,
    eventKind: event.eventKind,
    externalEntityId: event.externalEntityId ?? null,
    conversationExternalId: event.conversationExternalId ?? null,
    occurredAt: event.occurredAt ?? null,
    observedAt: event.observedAt,
    dedupeKey: event.dedupeKey,
    payloadJson: safeStringifyJson(event.payload) ?? "null",
    normalizedSchema,
  };
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
    this.sqlite = openSqliteDatabase(dbPath, { readonly: options.readonly });
    this.sqlite.exec(`PRAGMA busy_timeout = ${DEFAULT_SQLITE_BUSY_TIMEOUT_MS}`);
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
        const migrationIds = [migration.id, ...(migration.legacyIds ?? [])];
        const placeholders = migrationIds.map(() => "?").join(", ");
        const applied = this.sqlite
          .prepare(`SELECT id FROM schema_migrations WHERE id IN (${placeholders}) LIMIT 1`)
          .get(...migrationIds) as { id: string } | undefined;
        if (applied) {
          continue;
        }
      }

      this.sqlite.exec("BEGIN");
      try {
        if (migration.apply) {
          migration.apply(this.sqlite);
        } else if (migration.sql) {
          this.sqlite.exec(migration.sql);
        }
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

  executeReadOnlySql(query: string): unknown[] {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      throw new Error("SQL query must not be empty");
    }
    if (!/^(select|with|pragma|explain)\b/i.test(trimmed)) {
      throw new Error("Only read-only SELECT/PRAGMA/EXPLAIN queries are supported");
    }
    const statement = this.sqlite.prepare(trimmed) as Database.Statement & { reader?: boolean };
    if (statement.reader === false) {
      throw new Error("Only read-only queries are supported");
    }
    return statement.all();
  }

  listContactMergeAliases(): Array<{
    contact_id: string;
    canonical_contact_id: string;
  }> {
    return this.db
      .select({
        contact_id: contactMergeDecisions.secondaryContactId,
        canonical_contact_id: contactMergeDecisions.canonicalContactId,
      })
      .from(contactMergeDecisions)
      .orderBy(asc(contactMergeDecisions.createdAt), asc(contactMergeDecisions.id))
      .all() as Array<{
      contact_id: string;
      canonical_contact_id: string;
    }>;
  }

  planContactMergeDecisions(input: ContactMergeBatchInput[]): PlannedContactMergeDecision[] {
    if (input.length === 0) {
      throw new Error("At least one contact merge is required.");
    }

    const aliasMap = new Map(
      this.listContactMergeAliases().map((row) => [row.contact_id, row.canonical_contact_id]),
    );
    const planned: PlannedContactMergeDecision[] = [];
    for (const merge of input) {
      const primaryContactId = merge.primaryContactId.trim();
      const secondaryContactId = merge.secondaryContactId.trim();
      if (!primaryContactId || !secondaryContactId) {
        throw new Error("Primary and secondary contact ids are required.");
      }
      if (primaryContactId === secondaryContactId) {
        throw new Error("Cannot merge a contact into itself");
      }

      this.assertContactExists(primaryContactId, "Primary");
      this.assertContactExists(secondaryContactId, "Secondary");

      const canonicalPrimary = resolveCanonicalContactIdFromAliases(primaryContactId, aliasMap);
      const canonicalSecondary = resolveCanonicalContactIdFromAliases(secondaryContactId, aliasMap);
      if (canonicalPrimary === canonicalSecondary) {
        throw new Error(
          `Contacts already resolve to the same canonical contact: ${canonicalPrimary}`,
        );
      }

      aliasMap.set(canonicalSecondary, canonicalPrimary);
      resolveCanonicalContactIdFromAliases(canonicalSecondary, aliasMap);
      planned.push({
        decisionId: randomUUID(),
        primaryContactId: canonicalPrimary,
        secondaryContactId: canonicalSecondary,
        canonicalContactId: canonicalPrimary,
        reason: merge.reason ?? null,
      });
    }
    return planned;
  }

  recordContactMergeDecision(input: {
    primaryContactId: string;
    secondaryContactId: string;
    reason?: string | null;
    createdBy?: string | null;
  }): {
    decisionId: string;
    primaryContactId: string;
    secondaryContactId: string;
    canonicalContactId: string;
  } {
    const [decision] = this.recordContactMergeDecisionsBatch(
      [
        {
          primaryContactId: input.primaryContactId,
          secondaryContactId: input.secondaryContactId,
          reason: input.reason ?? null,
        },
      ],
      { createdBy: input.createdBy },
    );
    return {
      decisionId: decision!.decisionId,
      primaryContactId: decision!.primaryContactId,
      secondaryContactId: decision!.secondaryContactId,
      canonicalContactId: decision!.canonicalContactId,
    };
  }

  recordContactMergeDecisionsBatch(
    input: ContactMergeBatchInput[],
    options: { createdBy?: string | null } = {},
  ): PlannedContactMergeDecision[] {
    const planned = this.planContactMergeDecisions(input);
    const timestamp = now();
    return this.sqlite.transaction(() => {
      for (const decision of planned) {
        this.db
          .insert(contactMergeDecisions)
          .values({
            id: decision.decisionId,
            primaryContactId: decision.primaryContactId,
            secondaryContactId: decision.secondaryContactId,
            canonicalContactId: decision.canonicalContactId,
            reason: decision.reason,
            createdBy: options.createdBy ?? "cli",
            createdAt: timestamp,
          })
          .run();
        this.db
          .update(contactMemories)
          .set({ contactId: decision.canonicalContactId, updatedAt: timestamp })
          .where(eq(contactMemories.contactId, decision.secondaryContactId))
          .run();
      }
      return planned;
    })();
  }

  private assertContactExists(contactId: string, label: "Primary" | "Secondary"): void {
    const contact = this.sqlite
      .prepare(
        `
        SELECT id
        FROM contacts
        WHERE id = ?
        LIMIT 1
      `,
      )
      .get(contactId) as { id: string } | undefined;
    if (!contact) {
      throw new Error(`${label} contact not found: ${contactId}`);
    }
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

  markOnboardingCompleted(version: string): void {
    this.setAppSetting(APP_SETTING_KEYS.onboardingCompletedVersion, version);
  }

  private markReleaseCheck(at = now()): void {
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

  private getUpdateLastError(): UpdateErrorState | null {
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
    const byKey = new Map(
      (
        this.db
          .select({ key: appSettings.key, value: appSettings.value })
          .from(appSettings)
          .all() as Array<{ key: string; value: string | null }>
      ).map((row) => [row.key, row.value]),
    );
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
    last_success_at: number | null;
    last_error_summary: string | null;
  } | null {
    return (
      (this.db
        .select({
          source_cursor_json: syncCheckpoints.sourceCursorJson,
          sync_mode: syncCheckpoints.syncMode,
          raw_ingest_watermark: syncCheckpoints.rawIngestWatermark,
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
            last_success_at: number | null;
            last_error_summary: string | null;
          }
        | undefined) ?? null
    );
  }

  resetSource(platform: Platform): number {
    const removed = this.db.transaction((tx) => {
      const removedSourceAccounts = tx
        .delete(sourceAccounts)
        .where(eq(sourceAccounts.platform, platform))
        .run().changes;
      const removedRawEvents = tx
        .delete(rawEvents)
        .where(eq(rawEvents.platform, platform))
        .run().changes;
      const removedRuns = tx.delete(syncRuns).where(eq(syncRuns.platform, platform)).run().changes;
      const removedErrors = tx
        .delete(syncRunErrors)
        .where(eq(syncRunErrors.platform, platform))
        .run().changes;
      const removedCheckpoints = tx
        .delete(syncCheckpoints)
        .where(eq(syncCheckpoints.platform, platform))
        .run().changes;
      const removedSyncProofs = tx
        .delete(syncProofs)
        .where(eq(syncProofs.platform, platform))
        .run().changes;
      return (
        Number(removedSourceAccounts) +
        Number(removedRawEvents) +
        Number(removedRuns) +
        Number(removedErrors) +
        Number(removedCheckpoints) +
        Number(removedSyncProofs)
      );
    });

    this.upsertProjectionState({
      projectionWatermark: 0,
    });

    return removed;
  }

  listSyncProofs(platform: Platform, accountKey: string): SyncProofRow[] {
    return this.db
      .select({
        scope_kind: syncProofs.scopeKind,
        scope_key: syncProofs.scopeKey,
        proof_kind: syncProofs.proofKind,
        status: syncProofs.status,
        last_observed_at: syncProofs.lastObservedAt,
        resume_cursor_json: syncProofs.resumeCursorJson,
        coverage_json: syncProofs.coverageJson,
        stats_json: syncProofs.statsJson,
      })
      .from(syncProofs)
      .where(and(eq(syncProofs.platform, platform), eq(syncProofs.accountKey, accountKey)))
      .orderBy(asc(syncProofs.scopeKind), asc(syncProofs.scopeKey), asc(syncProofs.proofKind))
      .all() as SyncProofRow[];
  }

  upsertSyncProof(input: { platform: Platform; accountKey: string; proof: SyncProofInput }): void {
    assertKnownSyncProofKindContract(input.platform, input.proof);
    const timestamp = now();
    const proofId = buildSyncProofId(
      input.platform,
      input.accountKey,
      input.proof.scope.kind,
      input.proof.scope.key,
      input.proof.proofKind,
    );
    const resumeCursorJson = safeStringifyJson(input.proof.resumeCursor);
    const coverageJson = safeStringifyJson(input.proof.coverage);
    const statsJson = safeStringifyJson(input.proof.stats);

    this.db
      .insert(syncProofs)
      .values({
        id: proofId,
        platform: input.platform,
        accountKey: input.accountKey,
        scopeKind: input.proof.scope.kind,
        scopeKey: input.proof.scope.key,
        proofKind: input.proof.proofKind,
        status: input.proof.status,
        lastObservedAt: input.proof.observedAt,
        resumeCursorJson,
        coverageJson,
        statsJson,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: [
          syncProofs.platform,
          syncProofs.accountKey,
          syncProofs.scopeKind,
          syncProofs.scopeKey,
          syncProofs.proofKind,
        ],
        set: {
          status: input.proof.status,
          lastObservedAt: input.proof.observedAt,
          resumeCursorJson,
          coverageJson,
          statsJson,
          updatedAt: timestamp,
        },
      })
      .run();
  }

  getOverview(): {
    contacts: number;
    conversations: number;
    messages: number;
    rawEvents: number;
    sourceAccounts: number;
    integrations: number;
    authSessions: number;
    messageBreakdown: Array<{
      platform: Platform;
      messages: number;
    }>;
  } {
    return {
      contacts: this.countRows(contacts),
      conversations: this.countRows(conversations),
      messages: this.countRows(messages),
      rawEvents: this.countRows(rawEvents),
      sourceAccounts: this.countRows(sourceAccounts),
      integrations: this.countRows(integrationStates),
      authSessions: this.countRows(authSessions),
      messageBreakdown: this.listMessageCountsByPlatform(),
    };
  }

  getMenuBarOverview(): {
    contacts: number;
    conversations: number;
    messages: number;
    rawEvents: number;
    sourceAccounts: number;
    integrations: number;
    authSessions: number;
    messageBreakdown: Array<{
      platform: Platform;
      messages: number;
    }>;
  } {
    const messageBreakdown = this.listMessageCountsByPlatform();
    return {
      contacts: this.countRows(contacts),
      conversations: this.countRows(conversations),
      messages: messageBreakdown.reduce((total, row) => total + row.messages, 0),
      rawEvents: this.countRows(rawEvents),
      sourceAccounts: this.countRows(sourceAccounts),
      integrations: this.countRows(integrationStates),
      authSessions: this.countRows(authSessions),
      messageBreakdown,
    };
  }

  private listMessageCountsByPlatform(): Array<{
    platform: Platform;
    messages: number;
  }> {
    return this.sqlite
      .prepare(
        `
        SELECT platform, COUNT(*) AS messages
        FROM messages
        GROUP BY platform
        ORDER BY messages DESC, platform ASC
      `,
      )
      .all() as Array<{
      platform: Platform;
      messages: number;
    }>;
  }

  countObservedPhoneCalls(): number {
    const row = this.sqlite
      .prepare(
        `
        SELECT COUNT(*) AS calls
        FROM raw_events
        WHERE platform = 'imessage'
          AND account_key = 'local'
          AND COALESCE(normalized_schema, entity_kind || '.' || event_kind || '@1') = 'call.observed@1'
      `,
      )
      .get() as { calls: number | null };
    return Number(row.calls ?? 0);
  }

  getProjectionState(options: { initialize?: boolean } = {}): ProjectionStateRow {
    const row = this.db
      .select({
        singleton_key: projectionState.singletonKey,
        projection_watermark: projectionState.projectionWatermark,
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
      updated_at: now(),
    };
    if (options.initialize !== false) {
      this.upsertProjectionState({
        projectionWatermark: 0,
      });
    }
    return fallback;
  }

  private upsertProjectionState(input: { projectionWatermark: number }): void {
    const values = {
      singletonKey: "global" as const,
      projectionWatermark: input.projectionWatermark,
      updatedAt: now(),
    };

    this.db
      .insert(projectionState)
      .values(values)
      .onConflictDoUpdate({
        target: projectionState.singletonKey,
        set: {
          projectionWatermark: values.projectionWatermark,
          updatedAt: values.updatedAt,
        },
      })
      .run();
  }

  getProjectionBacklog(options: { initializeProjectionState?: boolean } = {}): {
    projection_watermark: number;
    max_raw_event_rowid: number;
    pending_raw_events: number;
  } {
    const state = this.getProjectionState({
      initialize: options.initializeProjectionState !== false,
    });
    const row = this.sqlite
      .prepare(
        `
        SELECT
          COALESCE(MAX(rowid), 0) AS max_raw_event_rowid
        FROM raw_events
      `,
      )
      .get() as {
      max_raw_event_rowid: number | null;
    };
    const maxRawEventRowid = Number(row.max_raw_event_rowid ?? 0);

    return {
      projection_watermark: state.projection_watermark,
      max_raw_event_rowid: maxRawEventRowid,
      pending_raw_events: Math.max(0, maxRawEventRowid - state.projection_watermark),
    };
  }

  getProjectionOverview(): {
    contacts: number;
    conversations: number;
    messages: number;
    rawEvents: number;
  } {
    return {
      contacts: this.countRows(contacts),
      conversations: this.countRows(conversations),
      messages: this.countRows(messages),
      rawEvents: this.countRows(rawEvents),
    };
  }

  async withBusyTimeout<T>(timeoutMs: number, task: () => T | Promise<T>): Promise<T> {
    const boundedTimeoutMs = Math.max(0, Math.trunc(timeoutMs));
    this.sqlite.exec(`PRAGMA busy_timeout = ${boundedTimeoutMs}`);
    try {
      return await task();
    } finally {
      this.sqlite.exec(`PRAGMA busy_timeout = ${DEFAULT_SQLITE_BUSY_TIMEOUT_MS}`);
    }
  }

  withBusyTimeoutSync<T>(timeoutMs: number, task: () => T): T {
    const boundedTimeoutMs = Math.max(0, Math.trunc(timeoutMs));
    this.sqlite.exec(`PRAGMA busy_timeout = ${boundedTimeoutMs}`);
    try {
      return task();
    } finally {
      this.sqlite.exec(`PRAGMA busy_timeout = ${DEFAULT_SQLITE_BUSY_TIMEOUT_MS}`);
    }
  }

  getIntegrationProjectionStats(
    platform: Platform,
    accountKey: string,
  ): {
    rawEvents: number;
    rawEventsBySchema: Record<string, number>;
    projectedContacts: number;
    projectedConversations: number;
    projectedMessages: number;
  } {
    const rawEventRows = this.sqlite
      .prepare(
        `
        SELECT
          COALESCE(normalized_schema, entity_kind || '.' || event_kind) AS schema_key,
          COUNT(*) AS count
        FROM raw_events
        WHERE platform = ? AND account_key = ?
        GROUP BY schema_key
        ORDER BY count DESC, schema_key ASC
      `,
      )
      .all(platform, accountKey) as Array<{
      schema_key: string | null;
      count: number | null;
    }>;
    const projectedCounts = this.sqlite
      .prepare(
        `
        SELECT
          (SELECT COUNT(*) FROM contact_sources WHERE platform = ? AND account_key = ?) AS projected_contacts,
          (SELECT COUNT(*) FROM conversations WHERE platform = ? AND account_key = ?) AS projected_conversations,
          (SELECT COUNT(*) FROM messages WHERE platform = ? AND account_key = ?) AS projected_messages
      `,
      )
      .get(platform, accountKey, platform, accountKey, platform, accountKey) as {
      projected_contacts: number | null;
      projected_conversations: number | null;
      projected_messages: number | null;
    };

    const rawEventsBySchema = Object.fromEntries(
      rawEventRows
        .filter((row) => typeof row.schema_key === "string" && row.schema_key.length > 0)
        .map((row) => [row.schema_key!, Number(row.count ?? 0)]),
    );

    return {
      rawEvents: rawEventRows.reduce((total, row) => total + Number(row.count ?? 0), 0),
      rawEventsBySchema,
      projectedContacts: Number(projectedCounts.projected_contacts ?? 0),
      projectedConversations: Number(projectedCounts.projected_conversations ?? 0),
      projectedMessages: Number(projectedCounts.projected_messages ?? 0),
    };
  }

  listIntegrationStates(): IntegrationStateRow[] {
    const rows = this.db
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
      .all() as Array<IntegrationStateRow & { platform: string }>;
    return rows.filter(hasKnownPlatform);
  }

  listEnabledSyncTargets(): Array<{ platform: Platform; account_key: string }> {
    const rows = this.db
      .select({
        platform: integrationStates.platform,
        account_key: integrationStates.accountKey,
      })
      .from(integrationStates)
      .where(and(eq(integrationStates.enabled, 1), eq(integrationStates.syncCapable, 1)))
      .orderBy(asc(integrationStates.platform), asc(integrationStates.accountKey))
      .all() as Array<{ platform: string; account_key: string }>;
    return rows.filter(hasKnownPlatform);
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

  getSourceAccountDisplayName(platform: Platform, accountKey: string): string | null {
    const row =
      (this.db
        .select({ display_name: sourceAccounts.displayName })
        .from(sourceAccounts)
        .where(
          and(eq(sourceAccounts.platform, platform), eq(sourceAccounts.accountKey, accountKey)),
        )
        .get() as { display_name: string | null } | undefined) ?? null;
    return row?.display_name ?? null;
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

    this.sqlite.transaction(() => {
      const existing = this.getIntegrationState(input.platform, input.accountKey);
      this.sqlite.exec("PRAGMA defer_foreign_keys = ON");
      this.db
        .insert(integrationStates)
        .values(values)
        .onConflictDoUpdate({
          target: [integrationStates.platform, integrationStates.accountKey],
          set: {
            id: values.id,
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

      if (existing && existing.id !== values.id) {
        this.db
          .update(authSessions)
          .set({
            integrationStateId: values.id,
            updatedAt: timestamp,
          })
          .where(eq(authSessions.integrationStateId, existing.id))
          .run();
      }
    })();
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

  clearIntegrationRuntimeState(platform: Platform, accountKey: string): number {
    return this.db.transaction((tx) => {
      const removedSourceAccounts = tx
        .delete(sourceAccounts)
        .where(
          and(eq(sourceAccounts.platform, platform), eq(sourceAccounts.accountKey, accountKey)),
        )
        .run().changes;
      const removedCheckpoints = tx
        .delete(syncCheckpoints)
        .where(
          and(eq(syncCheckpoints.platform, platform), eq(syncCheckpoints.accountKey, accountKey)),
        )
        .run().changes;
      const removedSyncProofs = tx
        .delete(syncProofs)
        .where(and(eq(syncProofs.platform, platform), eq(syncProofs.accountKey, accountKey)))
        .run().changes;
      const removedRunErrors = tx
        .delete(syncRunErrors)
        .where(and(eq(syncRunErrors.platform, platform), eq(syncRunErrors.accountKey, accountKey)))
        .run().changes;
      const removedRuns = tx
        .delete(syncRuns)
        .where(and(eq(syncRuns.platform, platform), eq(syncRuns.accountKey, accountKey)))
        .run().changes;
      return (
        Number(removedSourceAccounts) +
        Number(removedCheckpoints) +
        Number(removedSyncProofs) +
        Number(removedRunErrors) +
        Number(removedRuns)
      );
    });
  }

  addContactMemory(input: {
    contactId: string;
    body: string;
    sourceKind?: string;
    evidence?: unknown;
    confidence?: number | null;
    supersedesMemoryId?: string | null;
    createdBy?: string | null;
  }): ContactMemoryRow {
    const contactId = input.contactId.trim();
    const body = input.body.trim();
    const sourceKind = (input.sourceKind ?? "agent").trim() || "agent";
    const timestamp = now();
    const confidence =
      typeof input.confidence === "number" && Number.isFinite(input.confidence)
        ? Math.trunc(input.confidence)
        : null;

    if (!contactId) {
      throw new Error("Contact id is required.");
    }
    if (!body) {
      throw new Error("Contact memory body is required.");
    }
    if (confidence !== null && (confidence < 0 || confidence > 100)) {
      throw new Error("Contact memory confidence must be between 0 and 100.");
    }

    const contact = this.sqlite
      .prepare("SELECT id FROM contacts WHERE id = ? LIMIT 1")
      .get(contactId) as { id: string } | undefined;
    if (!contact) {
      throw new Error(`Contact not found: ${contactId}`);
    }

    const id = randomUUID();
    this.db.transaction((tx) => {
      if (input.supersedesMemoryId) {
        const superseded = this.sqlite
          .prepare("SELECT contact_id FROM contact_memories WHERE id = ? LIMIT 1")
          .get(input.supersedesMemoryId) as { contact_id: string } | undefined;
        if (!superseded) {
          throw new Error(`Contact memory not found: ${input.supersedesMemoryId}`);
        }
        if (superseded.contact_id !== contactId) {
          throw new Error("Cannot supersede a contact memory from a different contact.");
        }
        tx.update(contactMemories)
          .set({ staleAt: timestamp, updatedAt: timestamp })
          .where(eq(contactMemories.id, input.supersedesMemoryId))
          .run();
      }
      tx.insert(contactMemories)
        .values({
          id,
          contactId,
          body,
          sourceKind,
          evidenceJson: safeStringifyJson(input.evidence),
          confidence,
          supersedesMemoryId: input.supersedesMemoryId ?? null,
          staleAt: null,
          createdBy: input.createdBy ?? null,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
    });

    return this.getContactMemory(id)!;
  }

  private getContactMemory(id: string): ContactMemoryRow | null {
    return (
      (this.sqlite
        .prepare(
          `
          SELECT
            cn.id,
            cn.contact_id,
            c.name AS contact_name,
            cn.body,
            cn.source_kind,
            cn.evidence_json,
            cn.confidence,
            cn.supersedes_memory_id,
            cn.stale_at,
            cn.created_by,
            cn.created_at,
            cn.updated_at
          FROM contact_memories cn
          LEFT JOIN contacts c ON c.id = cn.contact_id
          WHERE cn.id = ?
          LIMIT 1
        `,
        )
        .get(id) as ContactMemoryRow | undefined) ?? null
    );
  }

  listContactMemories(input: {
    contactId: string;
    includeStale?: boolean;
    limit?: number;
  }): ContactMemoryRow[] {
    const contactId = input.contactId.trim();
    if (!contactId) {
      throw new Error("Contact id is required.");
    }
    const limit =
      typeof input.limit === "number" && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(500, Math.trunc(input.limit)))
        : 50;
    const filters = ["cn.contact_id = ?"];
    const params: unknown[] = [contactId];
    if (!input.includeStale) {
      filters.push("cn.stale_at IS NULL");
    }
    params.push(limit);

    return this.sqlite
      .prepare(
        `
        SELECT
          cn.id,
          cn.contact_id,
          c.name AS contact_name,
          cn.body,
          cn.source_kind,
          cn.evidence_json,
          cn.confidence,
          cn.supersedes_memory_id,
          cn.stale_at,
          cn.created_by,
          cn.created_at,
          cn.updated_at
        FROM contact_memories cn
        LEFT JOIN contacts c ON c.id = cn.contact_id
        WHERE ${filters.join(" AND ")}
        ORDER BY cn.created_at DESC
        LIMIT ?
      `,
      )
      .all(...params) as ContactMemoryRow[];
  }

  markContactMemoryStale(id: string, staleAt: number | null = null): ContactMemoryRow | null {
    const timestamp = staleAt ?? now();
    this.db
      .update(contactMemories)
      .set({ staleAt: timestamp, updatedAt: timestamp })
      .where(eq(contactMemories.id, id))
      .run();
    const memory = this.getContactMemory(id);
    if (!memory) {
      throw new Error(`Contact memory not found: ${id}`);
    }
    return memory;
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

  listActiveReactionsForMessage(
    platform: Platform,
    accountKey: string,
    platformMessageId: string,
  ): Array<{ reactor_source_key: string | null; emoji: string }> {
    return this.sqlite
      .prepare(
        `
          SELECT mr.reactor_source_key, mr.emoji
          FROM message_reactions mr
          JOIN messages m ON m.id = mr.message_id
          WHERE m.platform = ?
            AND m.account_key = ?
            AND m.platform_message_id = ?
            AND mr.is_active = 1
        `,
      )
      .all(platform, accountKey, platformMessageId) as Array<{
      reactor_source_key: string | null;
      emoji: string;
    }>;
  }

  listMessageAttachments(
    input: {
      attachmentId?: string;
      messageId?: string;
      conversationId?: string;
      platform?: Platform;
      accountKey?: string;
      limit?: number;
    } = {},
  ): MessageAttachmentRow[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (input.attachmentId) {
      clauses.push("ma.id = ?");
      params.push(input.attachmentId);
    }
    if (input.messageId) {
      clauses.push("ma.message_id = ?");
      params.push(input.messageId);
    }
    if (input.conversationId) {
      clauses.push("m.conversation_id = ?");
      params.push(input.conversationId);
    }
    if (input.platform) {
      clauses.push("ma.platform = ?");
      params.push(input.platform);
    }
    if (input.accountKey) {
      clauses.push("ma.account_key = ?");
      params.push(input.accountKey);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limitClause = input.limit ? "LIMIT ?" : "";
    if (input.limit) {
      params.push(input.limit);
    }

    return this.sqlite
      .prepare(
        `
        SELECT
          ma.id,
          ma.message_id,
          ma.platform,
          ma.account_key,
          ma.source_attachment_key,
          ma.kind,
          ma.mime_type,
          ma.filename,
          ma.title,
          ma.local_path,
          ma.remote_url,
          ma.size_bytes,
          ma.text_content,
          ma.access_kind,
          ma.access_ref_json,
          ma.created_at,
          ma.updated_at,
          m.conversation_id,
          m.platform_message_id,
          m.sent_at,
          m.content,
          m.sender_name,
          m.conversation_name
        FROM message_attachments ma
        JOIN messages m ON m.id = ma.message_id
        ${whereClause}
        ORDER BY m.sent_at DESC, ma.created_at DESC, ma.id ASC
        ${limitClause}
      `,
      )
      .all(...params) as MessageAttachmentRow[];
  }

  getMessageAttachment(attachmentId: string): MessageAttachmentRow | null {
    return this.listMessageAttachments({ attachmentId, limit: 1 })[0] ?? null;
  }

  getAttachmentCacheEntry(attachmentId: string, variant: string): AttachmentCacheRow | null {
    return (
      (this.sqlite
        .prepare(
          `
          SELECT
            id,
            attachment_id,
            variant,
            status,
            cache_path,
            mime_type,
            size_bytes,
            sha256,
            fetched_at,
            last_accessed_at,
            expires_at,
            last_error,
            created_at,
            updated_at
          FROM attachment_cache
          WHERE attachment_id = ?
            AND variant = ?
          LIMIT 1
        `,
        )
        .get(attachmentId, variant) as AttachmentCacheRow | undefined) ?? null
    );
  }

  upsertAttachmentCacheEntry(input: {
    attachmentId: string;
    variant: string;
    status: string;
    cachePath?: string | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
    sha256?: string | null;
    fetchedAt?: number | null;
    lastAccessedAt?: number | null;
    expiresAt?: number | null;
    lastError?: string | null;
  }): string {
    const timestamp = now();
    const existing = this.getAttachmentCacheEntry(input.attachmentId, input.variant);
    const id = existing?.id ?? randomUUID();
    this.db
      .insert(attachmentCache)
      .values({
        id,
        attachmentId: input.attachmentId,
        variant: input.variant,
        status: input.status,
        cachePath: input.cachePath ?? null,
        mimeType: input.mimeType ?? null,
        sizeBytes: input.sizeBytes ?? null,
        sha256: input.sha256 ?? null,
        fetchedAt: input.fetchedAt ?? null,
        lastAccessedAt: input.lastAccessedAt ?? input.fetchedAt ?? timestamp,
        expiresAt: input.expiresAt ?? null,
        lastError: input.lastError ?? null,
        createdAt: existing?.created_at ?? timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: [attachmentCache.attachmentId, attachmentCache.variant],
        set: {
          status: input.status,
          cachePath: input.cachePath ?? null,
          mimeType: input.mimeType ?? null,
          sizeBytes: input.sizeBytes ?? null,
          sha256: input.sha256 ?? null,
          fetchedAt: input.fetchedAt ?? null,
          lastAccessedAt: input.lastAccessedAt ?? input.fetchedAt ?? timestamp,
          expiresAt: input.expiresAt ?? null,
          lastError: input.lastError ?? null,
          updatedAt: timestamp,
        },
      })
      .run();
    return id;
  }

  touchAttachmentCacheEntry(attachmentId: string, variant: string, accessedAt = now()): void {
    this.db
      .update(attachmentCache)
      .set({
        lastAccessedAt: accessedAt,
        updatedAt: accessedAt,
      })
      .where(
        and(eq(attachmentCache.attachmentId, attachmentId), eq(attachmentCache.variant, variant)),
      )
      .run();
  }

  listReadyAttachmentCacheEntries(): AttachmentCacheRow[] {
    return this.sqlite
      .prepare(
        `
        SELECT
          id,
          attachment_id,
          variant,
          status,
          cache_path,
          mime_type,
          size_bytes,
          sha256,
          fetched_at,
          last_accessed_at,
          expires_at,
          last_error,
          created_at,
          updated_at
        FROM attachment_cache
        WHERE status = 'ready'
          AND cache_path IS NOT NULL
        ORDER BY COALESCE(last_accessed_at, fetched_at, updated_at, created_at) ASC, id ASC
      `,
      )
      .all() as AttachmentCacheRow[];
  }

  getAttachmentContent(attachmentId: string): AttachmentContentRow | null {
    return (
      (this.sqlite
        .prepare(
          `
          SELECT
            attachment_id,
            extractor,
            status,
            text_content,
            mime_type,
            extracted_at,
            last_error,
            created_at,
            updated_at
          FROM attachment_content
          WHERE attachment_id = ?
          LIMIT 1
        `,
        )
        .get(attachmentId) as AttachmentContentRow | undefined) ?? null
    );
  }

  upsertAttachmentContent(input: {
    attachmentId: string;
    extractor?: string | null;
    status: string;
    textContent?: string | null;
    mimeType?: string | null;
    extractedAt?: number | null;
    lastError?: string | null;
    filename?: string | null;
    title?: string | null;
  }): void {
    const timestamp = now();
    const existing = this.getAttachmentContent(input.attachmentId);
    this.db.transaction((tx) => {
      tx.insert(attachmentContent)
        .values({
          attachmentId: input.attachmentId,
          extractor: input.extractor ?? null,
          status: input.status,
          textContent: input.textContent ?? null,
          mimeType: input.mimeType ?? null,
          extractedAt: input.extractedAt ?? null,
          lastError: input.lastError ?? null,
          createdAt: existing?.created_at ?? timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoUpdate({
          target: attachmentContent.attachmentId,
          set: {
            extractor: input.extractor ?? null,
            status: input.status,
            textContent: input.textContent ?? null,
            mimeType: input.mimeType ?? null,
            extractedAt: input.extractedAt ?? null,
            lastError: input.lastError ?? null,
            updatedAt: timestamp,
          },
        })
        .run();

      tx.run(sql`DELETE FROM attachment_content_fts WHERE attachment_id = ${input.attachmentId}`);
      if (input.textContent && input.textContent.trim().length > 0) {
        tx.run(sql`
          INSERT INTO attachment_content_fts (attachment_id, filename, title, content)
          VALUES (${input.attachmentId}, ${input.filename ?? ""}, ${input.title ?? ""}, ${input.textContent})
        `);
      }
    });
  }

  searchAttachmentContent(input: {
    query: string;
    limit?: number;
    platform?: Platform;
    accountKey?: string;
    conversationId?: string;
  }): Array<{
    attachment_id: string;
    message_id: string;
    filename: string | null;
    title: string | null;
    platform: Platform;
    account_key: string;
    conversation_id: string;
    conversation_name: string | null;
    sender_name: string | null;
    sent_at: number;
    rank: number;
    snippet: string;
  }> {
    const clauses = ["attachment_content_fts MATCH ?"];
    const params: Array<string | number> = [input.query];
    if (input.platform) {
      clauses.push("ma.platform = ?");
      params.push(input.platform);
    }
    if (input.accountKey) {
      clauses.push("ma.account_key = ?");
      params.push(input.accountKey);
    }
    if (input.conversationId) {
      clauses.push("m.conversation_id = ?");
      params.push(input.conversationId);
    }
    const limit = input.limit ?? 20;
    params.push(limit);

    return this.sqlite
      .prepare(
        `
        SELECT
          ma.id AS attachment_id,
          ma.message_id,
          ma.filename,
          ma.title,
          ma.platform,
          ma.account_key,
          m.conversation_id,
          m.conversation_name,
          m.sender_name,
          m.sent_at,
          bm25(attachment_content_fts) AS rank,
          snippet(attachment_content_fts, 3, '[', ']', '…', 20) AS snippet
        FROM attachment_content_fts
        JOIN message_attachments ma ON ma.id = attachment_content_fts.attachment_id
        JOIN messages m ON m.id = ma.message_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY rank ASC, m.sent_at DESC
        LIMIT ?
      `,
      )
      .all(...params) as Array<{
      attachment_id: string;
      message_id: string;
      filename: string | null;
      title: string | null;
      platform: Platform;
      account_key: string;
      conversation_id: string;
      conversation_name: string | null;
      sender_name: string | null;
      sent_at: number;
      rank: number;
      snippet: string;
    }>;
  }

  recoverInProgressRuns(): number {
    const timestamp = now();
    const result = this.db
      .update(syncRuns)
      .set({
        status: "queued",
        scheduledAt: timestamp,
        ownerId: null,
        leaseExpiresAt: null,
      })
      .where(sql`${syncRuns.status} IN ('ingesting', 'projecting')`)
      .run();
    return Number(result.changes);
  }

  queueSyncRun(input: {
    platform?: Platform | null;
    accountKey?: string | null;
    runType: SyncRunType;
    trigger: string;
    details?: unknown;
    scheduledAt?: number;
    delayMs?: number;
  }): string {
    const id = randomUUID();
    const queuedAt = now();
    const scheduledAt =
      input.scheduledAt ??
      (input.delayMs != null && Number.isFinite(input.delayMs)
        ? queuedAt + Math.max(0, Math.trunc(input.delayMs))
        : queuedAt);
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
        scheduledAt,
        startedAt: null,
        finishedAt: null,
        attempt: 0,
        ownerId: null,
        leaseExpiresAt: null,
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
      scheduledAt?: number;
      delayMs?: number;
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
          const scheduledAt =
            input.scheduledAt ??
            (input.delayMs != null && Number.isFinite(input.delayMs)
              ? queuedAt + Math.max(0, Math.trunc(input.delayMs))
              : queuedAt);
          runIds.push(id);
          return {
            id,
            platform: input.platform ?? null,
            accountKey: input.accountKey ?? null,
            runType: input.runType,
            status: "queued" as const,
            trigger: input.trigger,
            queuedAt,
            scheduledAt,
            startedAt: null,
            finishedAt: null,
            attempt: 0,
            ownerId: null,
            leaseExpiresAt: null,
            detailsJson: safeStringifyJson(input.details),
          };
        });

        tx.insert(syncRuns).values(rows).run();
      }
    });

    return runIds;
  }

  enqueueMessageFtsIndex(messageIds: Iterable<string>): number {
    const uniqueMessageIds = [...new Set([...messageIds].filter((id) => id.length > 0))];
    if (uniqueMessageIds.length === 0) {
      return 0;
    }
    const timestamp = now();
    let changed = 0;
    this.db.transaction((tx) => {
      for (const chunk of chunkArray(uniqueMessageIds, WRITE_BATCH_SIZE)) {
        for (const messageId of chunk) {
          changed += tx
            .insert(messageFtsIndexQueue)
            .values({
              messageId,
              status: "queued",
              queuedAt: timestamp,
              updatedAt: timestamp,
            })
            .onConflictDoUpdate({
              target: messageFtsIndexQueue.messageId,
              set: {
                status: "queued",
                updatedAt: timestamp,
              },
            })
            .run().changes;
        }
      }
    });
    return changed;
  }

  private claimMessageFtsIndexBatch(limit: number): MessageFtsIndexQueueRow[] {
    const normalizedLimit = Math.max(1, Math.trunc(limit));
    const timestamp = now();
    return this.sqlite.transaction(() => {
      const rows = this.db
        .select({
          message_id: messageFtsIndexQueue.messageId,
          status: messageFtsIndexQueue.status,
          queued_at: messageFtsIndexQueue.queuedAt,
          updated_at: messageFtsIndexQueue.updatedAt,
        })
        .from(messageFtsIndexQueue)
        .where(eq(messageFtsIndexQueue.status, "queued"))
        .orderBy(asc(messageFtsIndexQueue.queuedAt))
        .limit(normalizedLimit)
        .all() as MessageFtsIndexQueueRow[];
      if (rows.length === 0) {
        return rows;
      }
      this.db
        .update(messageFtsIndexQueue)
        .set({
          status: "indexing",
          updatedAt: timestamp,
        })
        .where(
          inArray(
            messageFtsIndexQueue.messageId,
            rows.map((row) => row.message_id),
          ),
        )
        .run();
      return rows.map((row) => ({
        ...row,
        status: "indexing" as const,
        updated_at: timestamp,
      }));
    })();
  }

  requeueStaleMessageFtsIndexing(staleBefore: number): number {
    return this.db
      .update(messageFtsIndexQueue)
      .set({
        status: "queued",
        updatedAt: now(),
      })
      .where(
        and(
          eq(messageFtsIndexQueue.status, "indexing"),
          sql`${messageFtsIndexQueue.updatedAt} < ${staleBefore}`,
        ),
      )
      .run().changes;
  }

  private completeMessageFtsIndex(messageIds: Iterable<string>): number {
    const ids = [...new Set([...messageIds])];
    if (ids.length === 0) {
      return 0;
    }
    return this.db
      .delete(messageFtsIndexQueue)
      .where(inArray(messageFtsIndexQueue.messageId, ids))
      .run().changes;
  }

  private failMessageFtsIndex(messageIds: Iterable<string>): number {
    const ids = [...new Set([...messageIds])];
    if (ids.length === 0) {
      return 0;
    }
    return this.db
      .update(messageFtsIndexQueue)
      .set({
        status: "failed",
        updatedAt: now(),
      })
      .where(inArray(messageFtsIndexQueue.messageId, ids))
      .run().changes;
  }

  private replaceMessageFtsIndexForIds(messageIds: Iterable<string>): number {
    const ids = [...new Set([...messageIds].filter((id) => id.length > 0))];
    if (ids.length === 0) {
      return 0;
    }
    let indexed = 0;
    this.db.transaction((tx) => {
      for (const chunk of chunkArray(ids, WRITE_BATCH_SIZE)) {
        tx.run(sql`
          DELETE FROM messages_fts
          WHERE rowid IN (
            SELECT rowid
            FROM messages
            WHERE id IN (${sqlValueList(chunk)})
          )
        `);
        indexed += tx.run(sql`
          INSERT INTO messages_fts (
            rowid,
            message_id,
            sender_name,
            conversation_name,
            participant_names,
            attachment_text,
            content
          )
          SELECT
            message_rowid,
            message_id,
            sender_name,
            conversation_name,
            participant_names,
            attachment_text,
            content
          FROM message_fts_source
          WHERE message_id IN (${sqlValueList(chunk)})
        `).changes;
      }
    });
    return indexed;
  }

  drainMessageFtsIndexQueue(limit: number): {
    claimed: number;
    indexed: number;
    failed: number;
  } {
    const rows = this.claimMessageFtsIndexBatch(limit);
    if (rows.length === 0) {
      return { claimed: 0, indexed: 0, failed: 0 };
    }
    const messageIds = rows.map((row) => row.message_id);
    try {
      const indexed = this.replaceMessageFtsIndexForIds(messageIds);
      this.completeMessageFtsIndex(messageIds);
      return { claimed: rows.length, indexed, failed: 0 };
    } catch {
      this.failMessageFtsIndex(messageIds);
      return { claimed: rows.length, indexed: 0, failed: rows.length };
    }
  }

  getMessageFtsIndexBacklog(): {
    queued: number;
    indexing: number;
    failed: number;
    pending: number;
  } {
    const rows = this.sqlite
      .prepare(
        `
        SELECT status, COUNT(*) AS count
        FROM message_fts_index_queue
        GROUP BY status
      `,
      )
      .all() as Array<{ status: string; count: number }>;
    const counts = { queued: 0, indexing: 0, failed: 0 };
    for (const row of rows) {
      if (row.status === "queued" || row.status === "indexing" || row.status === "failed") {
        counts[row.status] = Number(row.count ?? 0);
      }
    }
    return {
      ...counts,
      pending: counts.queued + counts.indexing,
    };
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
    options: { ownerId?: string; leaseMs?: number } = {},
  ): QueuedSyncRun | null {
    const timestamp = now();
    return this.db.transaction((tx) => {
      const typePredicate =
        runTypes && runTypes.length > 0 ? inArray(syncRuns.runType, runTypes) : sql`1 = 1`;
      const activeStatus = nextStatus === "projecting" ? "projecting" : "ingesting";
      const claimablePredicate = and(
        typePredicate,
        sql`(
          (${syncRuns.status} = 'queued' AND ${syncRuns.scheduledAt} <= ${timestamp})
          OR (
            ${syncRuns.status} = ${activeStatus}
            AND ${syncRuns.leaseExpiresAt} IS NOT NULL
            AND ${syncRuns.leaseExpiresAt} <= ${timestamp}
          )
        )`,
      );

      const row = tx
        .select({
          id: syncRuns.id,
          platform: syncRuns.platform,
          account_key: syncRuns.accountKey,
          run_type: syncRuns.runType,
          status: syncRuns.status,
          trigger: syncRuns.trigger,
          queued_at: syncRuns.queuedAt,
          scheduled_at: syncRuns.scheduledAt,
          started_at: syncRuns.startedAt,
          attempt: syncRuns.attempt,
          owner_id: syncRuns.ownerId,
          lease_expires_at: syncRuns.leaseExpiresAt,
          details_json: syncRuns.detailsJson,
        })
        .from(syncRuns)
        .where(claimablePredicate)
        .orderBy(asc(syncRuns.scheduledAt), asc(syncRuns.queuedAt))
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
            scheduled_at: number;
            started_at: number | null;
            attempt: number;
            owner_id: string | null;
            lease_expires_at: number | null;
            details_json: string | null;
          }
        | undefined;

      if (!row) {
        return null;
      }

      const startedAt = row.started_at ?? timestamp;
      const leaseExpiresAt =
        options.leaseMs == null ? null : timestamp + Math.max(1, Math.trunc(options.leaseMs));
      const ownerId = options.ownerId ?? null;
      tx.update(syncRuns)
        .set({
          status: nextStatus,
          startedAt,
          attempt: row.attempt + 1,
          ownerId,
          leaseExpiresAt,
        })
        .where(eq(syncRuns.id, row.id))
        .run();

      return {
        ...row,
        status: nextStatus,
        started_at: startedAt,
        attempt: row.attempt + 1,
        owner_id: ownerId,
        lease_expires_at: leaseExpiresAt,
      };
    });
  }

  getNextQueuedRunScheduledAt(runTypes?: SyncRunType[]): number | null {
    const statusPredicate =
      runTypes && runTypes.length > 0
        ? and(eq(syncRuns.status, "queued"), inArray(syncRuns.runType, runTypes))
        : eq(syncRuns.status, "queued");
    const row = this.db
      .select({ scheduled_at: syncRuns.scheduledAt })
      .from(syncRuns)
      .where(statusPredicate)
      .orderBy(asc(syncRuns.scheduledAt), asc(syncRuns.queuedAt))
      .limit(1)
      .get() as { scheduled_at: number } | undefined;
    return row?.scheduled_at ?? null;
  }

  getNextClaimableRunAt(
    runTypes?: SyncRunType[],
    activeStatus: SyncRunStatus = "ingesting",
  ): number | null {
    const typePredicate =
      runTypes && runTypes.length > 0 ? inArray(syncRuns.runType, runTypes) : sql`1 = 1`;
    const row = this.db
      .select({
        next_at: sql<number>`MIN(
          CASE
            WHEN ${syncRuns.status} = 'queued' THEN ${syncRuns.scheduledAt}
            WHEN ${syncRuns.status} = ${activeStatus} THEN ${syncRuns.leaseExpiresAt}
          END
        )`,
      })
      .from(syncRuns)
      .where(
        and(
          typePredicate,
          sql`(
            ${syncRuns.status} = 'queued'
            OR (${syncRuns.status} = ${activeStatus} AND ${syncRuns.leaseExpiresAt} IS NOT NULL)
          )`,
        ),
      )
      .get() as { next_at: number | null } | undefined;
    return row?.next_at ?? null;
  }

  private syncRunClaimPredicate(runId: string, claim?: SyncRunClaim) {
    const predicates = [eq(syncRuns.id, runId)];
    if (claim) {
      predicates.push(eq(syncRuns.attempt, claim.attempt));
      predicates.push(
        claim.ownerId == null
          ? sql`${syncRuns.ownerId} IS NULL`
          : eq(syncRuns.ownerId, claim.ownerId),
      );
    }
    return and(...predicates);
  }

  updateRunProgress(
    runId: string,
    input: { details?: unknown; leaseMs?: number; claim?: SyncRunClaim } = {},
  ): boolean {
    const timestamp = now();
    const result = this.db
      .update(syncRuns)
      .set({
        leaseExpiresAt:
          input.leaseMs == null ? undefined : timestamp + Math.max(1, Math.trunc(input.leaseMs)),
        detailsJson: input.details === undefined ? undefined : safeStringifyJson(input.details),
      })
      .where(this.syncRunClaimPredicate(runId, input.claim))
      .run();
    return Number(result.changes) > 0;
  }

  finishRun(runId: string, details?: unknown, claim?: SyncRunClaim): boolean {
    const values: {
      status: SyncRunStatus;
      finishedAt: number;
      ownerId: null;
      leaseExpiresAt: null;
      detailsJson?: string | null;
    } =
      details === undefined
        ? {
            status: "completed",
            finishedAt: now(),
            ownerId: null,
            leaseExpiresAt: null,
          }
        : {
            status: "completed",
            finishedAt: now(),
            ownerId: null,
            leaseExpiresAt: null,
            detailsJson: safeStringifyJson(details),
          };

    const result = this.db
      .update(syncRuns)
      .set(values)
      .where(this.syncRunClaimPredicate(runId, claim))
      .run();
    return Number(result.changes) > 0;
  }

  getLatestFinishedSyncRun(
    platform: Platform,
    accountKey: string,
  ): {
    status: "completed" | "failed";
    finished_at: number;
    details_json: string | null;
  } | null {
    return (
      (this.db
        .select({
          status: syncRuns.status,
          finished_at: syncRuns.finishedAt,
          details_json: syncRuns.detailsJson,
        })
        .from(syncRuns)
        .where(
          and(
            eq(syncRuns.platform, platform),
            eq(syncRuns.accountKey, accountKey),
            inArray(syncRuns.runType, ["sync", "sync_resume"]),
            inArray(syncRuns.status, ["completed", "failed"]),
            sql`${syncRuns.finishedAt} IS NOT NULL`,
          ),
        )
        .orderBy(desc(syncRuns.finishedAt))
        .limit(1)
        .get() as
        | {
            status: "completed" | "failed";
            finished_at: number;
            details_json: string | null;
          }
        | undefined) ?? null
    );
  }

  failRun(runId: string, errorMessage: string, details?: unknown, claim?: SyncRunClaim): boolean {
    let updated = false;
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
        ownerId: null;
        leaseExpiresAt: null;
        detailsJson?: string | null;
      } =
        details === undefined
          ? {
              status: "failed",
              finishedAt: now(),
              ownerId: null,
              leaseExpiresAt: null,
            }
          : {
              status: "failed",
              finishedAt: now(),
              ownerId: null,
              leaseExpiresAt: null,
              detailsJson: safeStringifyJson(details),
            };

      const result = tx
        .update(syncRuns)
        .set(values)
        .where(this.syncRunClaimPredicate(runId, claim))
        .run();
      updated = Number(result.changes) > 0;
      if (!updated) {
        return;
      }

      tx.insert(syncRunErrors)
        .values({
          id: randomUUID(),
          platform: run?.platform ?? null,
          accountKey: run?.accountKey ?? null,
          errorMessage,
          createdAt: now(),
        })
        .run();
    });
    return updated;
  }

  getLatestSyncRunError(
    platform: Platform,
    accountKey: string,
  ): {
    error_message: string;
    created_at: number;
  } | null {
    return (
      (this.db
        .select({
          error_message: syncRunErrors.errorMessage,
          created_at: syncRunErrors.createdAt,
        })
        .from(syncRunErrors)
        .where(and(eq(syncRunErrors.platform, platform), eq(syncRunErrors.accountKey, accountKey)))
        .orderBy(desc(syncRunErrors.createdAt))
        .limit(1)
        .get() as
        | {
            error_message: string;
            created_at: number;
          }
        | undefined) ?? null
    );
  }

  upsertSourceAccounts(inputs: SourceAccountInput[]): void {
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
              displayName: input.displayName,
              createdAt: timestamp,
              updatedAt: timestamp,
            })),
          )
          .onConflictDoUpdate({
            target: [sourceAccounts.platform, sourceAccounts.accountKey],
            set: {
              displayName: sql`excluded.display_name`,
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
      syncMode: input.syncMode,
      lastSuccessAt: input.lastSuccessAt ?? null,
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
          syncMode: values.syncMode,
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
        lastErrorSummary: errorSummary,
        updatedAt: now(),
      })
      .where(
        and(eq(syncCheckpoints.platform, platform), eq(syncCheckpoints.accountKey, accountKey)),
      )
      .run();
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
          .values(chunk.map((event) => buildRawEventValues(event)))
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

  quarantineRawEventProjectionFailure(
    event: {
      rowid: number;
    },
    error: unknown,
  ): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.db
      .insert(rawEventProjectionFailures)
      .values({
        rawEventRowId: event.rowid,
        errorMessage,
      })
      .onConflictDoUpdate({
        target: rawEventProjectionFailures.rawEventRowId,
        set: {
          errorMessage,
        },
      })
      .run();
  }

  listWhatsAppHistoryBackfillAnchors(
    accountKey: string,
    limit = 50,
  ): WhatsAppHistoryBackfillAnchorRow[] {
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 500));
    const scanLimit = Math.max(500, Math.min(boundedLimit * 100, 5_000));
    const rows = this.sqlite
      .prepare(
        `
        SELECT
          external_entity_id,
          conversation_external_id,
          occurred_at,
          payload_json
        FROM raw_events
        WHERE platform = 'whatsapp'
          AND account_key = ?
          AND entity_kind = 'message'
          AND event_kind = 'created'
          AND external_entity_id IS NOT NULL
          AND conversation_external_id IS NOT NULL
          AND occurred_at IS NOT NULL
        ORDER BY occurred_at DESC, observed_at DESC
        LIMIT ?
      `,
      )
      .all(accountKey, scanLimit) as Array<{
      external_entity_id: string | null;
      conversation_external_id: string | null;
      occurred_at: number | null;
      payload_json: string;
    }>;

    const anchors = new Map<string, WhatsAppHistoryBackfillAnchorRow>();
    for (const row of rows) {
      const chatJID = row.conversation_external_id?.trim();
      const messageID = row.external_entity_id?.trim();
      const timestamp = row.occurred_at;
      if (!chatJID || !messageID || typeof timestamp !== "number" || anchors.has(chatJID)) {
        continue;
      }
      let fromMe = false;
      try {
        const payload = JSON.parse(row.payload_json) as { isFromMe?: unknown };
        fromMe = payload.isFromMe === true;
      } catch {
        fromMe = false;
      }
      anchors.set(chatJID, {
        chatJID,
        messageID,
        timestamp,
        fromMe,
      });
      if (anchors.size >= boundedLimit) {
        break;
      }
    }
    return [...anchors.values()];
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
    normalized_schema: string | null;
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
          normalized_schema,
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
      normalized_schema: string | null;
      observed_at: number;
      payload_json: string;
    }>;
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
    normalized_schema: string | null;
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
          normalized_schema,
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
      normalized_schema: string | null;
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
          scheduled_at: syncRuns.scheduledAt,
          started_at: syncRuns.startedAt,
          attempt: syncRuns.attempt,
          owner_id: syncRuns.ownerId,
          lease_expires_at: syncRuns.leaseExpiresAt,
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

  rescheduleRun(runId: string, scheduledAt: number): void {
    this.db
      .update(syncRuns)
      .set({
        scheduledAt: Math.max(0, Math.trunc(scheduledAt)),
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

  private countRows(table: SQLiteTable): number {
    const row = this.db.select({ count: sql<number>`count(*)` }).from(table).get();

    return Number(row?.count ?? 0);
  }
}

export function openCuedDatabase(dbPath?: string): CuedDatabase {
  const db = new CuedDatabase(dbPath);
  db.migrate();
  db.setAppSetting(APP_SETTING_KEYS.installedAppVersion, getCurrentAppVersion());
  db.setAppSetting(APP_SETTING_KEYS.releaseChannel, getCurrentReleaseChannel());
  return db;
}

export function openExistingCuedDatabase(
  dbPath?: string,
  options: { readonly?: boolean } = {},
): CuedDatabase {
  const resolvedPath = dbPath ?? CUED_DB_PATH;
  if (!existsSync(resolvedPath)) {
    throw new Error(`Cued database does not exist at ${resolvedPath}`);
  }

  return new CuedDatabase(resolvedPath, options);
}

export function openCuedDatabaseReadOnly(dbPath?: string): CuedDatabase {
  if (!existsSync(dbPath ?? CUED_DB_PATH)) {
    return openCuedDatabase(dbPath);
  }

  return new CuedDatabase(dbPath, { readonly: true });
}
