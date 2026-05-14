import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
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
  JobKind,
  JobStatus,
  Platform,
  ProviderRawEventInput,
  RawEventEntityKind,
  SyncMode,
  SyncProofInput,
  SyncRunStatus,
  SyncRunType,
} from "../core/types/provider.js";
import {
  normalizeRawEventProvenance,
  parsePlatform,
  resolveRawEventNormalizedSchema,
} from "../core/types/provider.js";
import { normalizePhone, toE164 } from "../core/utils/phone.js";
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
  conversationParticipants,
  conversations,
  daemonState,
  integrationStates,
  jobs,
  messageAttachments,
  messageFtsIndexQueue,
  messageReactions,
  messages,
  outboundMessages,
  projectionState,
  rawEvents,
  sourceAccounts,
  slackBackfillProofs,
  syncProofs,
  syncScopes,
  syncCheckpoints,
  syncRunErrors,
  syncRuns,
  timelineEvents,
} = schema;

const APP_SETTING_KEYS = {
  cliSymlinkInstalled: "cli_symlink_installed",
  installedAppVersion: "installed_app_version",
  lastReleaseCheckAt: "last_release_check_at",
  messagesAutomationVerification: "messages_automation_verification_json",
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
  details_json: string | null;
}

export interface QueuedJob {
  id: string;
  kind: JobKind;
  platform: Platform | null;
  account_key: string | null;
  priority: number;
  status: JobStatus;
  trigger: string;
  queued_at: number;
  scheduled_at: number;
  started_at: number | null;
  attempt: number;
  owner_id: string | null;
  lease_expires_at: number | null;
  last_progress_at: number | null;
  checkpoint_json: string | null;
  progress_json: string | null;
  error_json: string | null;
}

export interface MessageFtsIndexQueueRow {
  message_id: string;
  reason: string;
  status: "queued" | "indexing" | "completed" | "failed";
  attempt: number;
  queued_at: number;
  updated_at: number;
  last_error: string | null;
}

export interface ContactMemoryRow {
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

export interface PlannedContactMergeDecision {
  decisionId: string;
  primaryContactId: string;
  secondaryContactId: string;
  canonicalContactId: string;
  reason: string | null;
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

export interface MessagesAutomationVerificationState {
  status: "granted" | "unknown";
  verifiedAt: number | null;
  checkedAt: number;
  summary: string | null;
}

export interface SyncScopeRow {
  id: string;
  platform: Platform;
  account_key: string;
  scope_kind: string;
  scope_key: string;
  parent_scope_id: string | null;
  display_name: string | null;
  metadata_json: string | null;
  first_discovered_at: number;
  last_observed_at: number;
  created_at: number;
  updated_at: number;
}

export interface SyncProofRow {
  id: string;
  platform: Platform;
  account_key: string;
  scope_id: string;
  scope_kind: string;
  scope_key: string;
  parent_scope_id: string | null;
  display_name: string | null;
  metadata_json: string | null;
  proof_kind: string;
  status: string;
  sync_mode: SyncMode | null;
  run_started_at: number | null;
  last_observed_at: number;
  completed_at: number | null;
  fresh_until: number | null;
  resume_cursor_json: string | null;
  coverage_json: string | null;
  stats_json: string | null;
  error_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface ContactMergeDecisionRow {
  id: string;
  decision_type: string;
  primary_contact_id: string;
  secondary_contact_id: string;
  canonical_contact_id: string;
  reason: string | null;
  created_by: string | null;
  created_at: number;
}

function buildSyncScopeId(
  platform: Platform,
  accountKey: string,
  scopeKind: string,
  scopeKey: string,
): string {
  return `scope:${Buffer.from(JSON.stringify([platform, accountKey, scopeKind, scopeKey])).toString(
    "base64url",
  )}`;
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
  preview_ref_json: string | null;
  availability_status: string | null;
  provider_metadata_json: string | null;
  metadata_json: string | null;
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

export interface AttachmentContentRow {
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

export interface DiscordSendResolution {
  target: string;
  threadId: string | null;
  resolution: "channel_id" | "source_conversation_key" | "conversation_name";
  matchedConversationId: string | null;
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
  const e164Phone = toE164(trimmed);
  if (e164Phone) {
    return e164Phone;
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

function toWhatsAppJidFromPhone(value: string): string | null {
  const e164Phone = toE164(value);
  if (!e164Phone) {
    return null;
  }
  return `${e164Phone.slice(1)}@s.whatsapp.net`;
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
  const provenance = normalizeRawEventProvenance(event.provenance);
  const normalizedSchema = resolveRawEventNormalizedSchema(event);
  assertCanonicalNormalizedSchemaForWrite(normalizedSchema);
  assertCanonicalRawEventPayloadForWrite({ ...event, normalizedSchema });
  return {
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
    normalizedSchema,
    provenanceJson: safeStringifyJson(provenance),
    sourceVersion: event.sourceVersion ?? null,
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

  listContactMergeDecisions(): ContactMergeDecisionRow[] {
    return this.db
      .select({
        id: contactMergeDecisions.id,
        decision_type: contactMergeDecisions.decisionType,
        primary_contact_id: contactMergeDecisions.primaryContactId,
        secondary_contact_id: contactMergeDecisions.secondaryContactId,
        canonical_contact_id: contactMergeDecisions.canonicalContactId,
        reason: contactMergeDecisions.reason,
        created_by: contactMergeDecisions.createdBy,
        created_at: contactMergeDecisions.createdAt,
      })
      .from(contactMergeDecisions)
      .orderBy(asc(contactMergeDecisions.createdAt), asc(contactMergeDecisions.id))
      .all() as ContactMergeDecisionRow[];
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
      .where(eq(contactMergeDecisions.decisionType, "merge"))
      .orderBy(asc(contactMergeDecisions.createdAt), asc(contactMergeDecisions.id))
      .all() as Array<{
      contact_id: string;
      canonical_contact_id: string;
    }>;
  }

  resolveCanonicalContactId(contactId: string): string {
    const aliasMap = new Map(
      this.listContactMergeAliases().map((row) => [row.contact_id, row.canonical_contact_id]),
    );
    return resolveCanonicalContactIdFromAliases(contactId, aliasMap);
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
            decisionType: "merge",
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

  setMessagesAutomationVerification(value: MessagesAutomationVerificationState | null): void {
    this.setAppSetting(APP_SETTING_KEYS.messagesAutomationVerification, safeStringifyJson(value));
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

  getMessagesAutomationVerification(): MessagesAutomationVerificationState | null {
    const parsed = safeParseJson<Partial<MessagesAutomationVerificationState> | null>(
      this.getAppSetting(APP_SETTING_KEYS.messagesAutomationVerification)?.value ?? null,
      "app_settings.messages_automation_verification_json",
      null,
    );
    if (!parsed) {
      return null;
    }

    const status = parsed.status === "granted" ? "granted" : "unknown";
    const checkedAt = typeof parsed.checkedAt === "number" ? parsed.checkedAt : null;
    if (checkedAt === null) {
      return null;
    }

    return {
      status,
      verifiedAt: typeof parsed.verifiedAt === "number" ? parsed.verifiedAt : null,
      checkedAt,
      summary: typeof parsed.summary === "string" ? parsed.summary : null,
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
      const removedSyncScopes = tx
        .delete(syncScopes)
        .where(eq(syncScopes.platform, platform))
        .run().changes;
      const removedSlackBackfillProofs =
        platform === "slack" ? tx.delete(slackBackfillProofs).run().changes : 0;
      return (
        Number(removedSourceAccounts) +
        Number(removedRawEvents) +
        Number(removedRuns) +
        Number(removedErrors) +
        Number(removedCheckpoints) +
        Number(removedSyncProofs) +
        Number(removedSyncScopes) +
        Number(removedSlackBackfillProofs)
      );
    });

    this.upsertProjectionState({
      projectionWatermark: 0,
      lastProjectedAt: null,
      lastRebuildAt: null,
    });

    return removed;
  }

  listSyncScopes(platform: Platform, accountKey: string): SyncScopeRow[] {
    return this.db
      .select({
        id: syncScopes.id,
        platform: syncScopes.platform,
        account_key: syncScopes.accountKey,
        scope_kind: syncScopes.scopeKind,
        scope_key: syncScopes.scopeKey,
        parent_scope_id: syncScopes.parentScopeId,
        display_name: syncScopes.displayName,
        metadata_json: syncScopes.metadataJson,
        first_discovered_at: syncScopes.firstDiscoveredAt,
        last_observed_at: syncScopes.lastObservedAt,
        created_at: syncScopes.createdAt,
        updated_at: syncScopes.updatedAt,
      })
      .from(syncScopes)
      .where(and(eq(syncScopes.platform, platform), eq(syncScopes.accountKey, accountKey)))
      .orderBy(asc(syncScopes.scopeKind), asc(syncScopes.scopeKey))
      .all() as SyncScopeRow[];
  }

  listSyncProofs(platform: Platform, accountKey: string): SyncProofRow[] {
    return this.db
      .select({
        id: syncProofs.id,
        platform: syncProofs.platform,
        account_key: syncProofs.accountKey,
        scope_id: syncProofs.scopeId,
        scope_kind: syncScopes.scopeKind,
        scope_key: syncScopes.scopeKey,
        parent_scope_id: syncScopes.parentScopeId,
        display_name: syncScopes.displayName,
        metadata_json: syncScopes.metadataJson,
        proof_kind: syncProofs.proofKind,
        status: syncProofs.status,
        sync_mode: syncProofs.syncMode,
        run_started_at: syncProofs.runStartedAt,
        last_observed_at: syncProofs.lastObservedAt,
        completed_at: syncProofs.completedAt,
        fresh_until: syncProofs.freshUntil,
        resume_cursor_json: syncProofs.resumeCursorJson,
        coverage_json: syncProofs.coverageJson,
        stats_json: syncProofs.statsJson,
        error_json: syncProofs.errorJson,
        created_at: syncProofs.createdAt,
        updated_at: syncProofs.updatedAt,
      })
      .from(syncProofs)
      .innerJoin(syncScopes, eq(syncProofs.scopeId, syncScopes.id))
      .where(and(eq(syncProofs.platform, platform), eq(syncProofs.accountKey, accountKey)))
      .orderBy(asc(syncScopes.scopeKind), asc(syncScopes.scopeKey), asc(syncProofs.proofKind))
      .all() as SyncProofRow[];
  }

  upsertSyncProof(input: { platform: Platform; accountKey: string; proof: SyncProofInput }): void {
    assertKnownSyncProofKindContract(input.platform, input.proof);
    const timestamp = now();
    const scopeId = buildSyncScopeId(
      input.platform,
      input.accountKey,
      input.proof.scope.kind,
      input.proof.scope.key,
    );
    const parentScopeId = input.proof.scope.parent
      ? buildSyncScopeId(
          input.platform,
          input.accountKey,
          input.proof.scope.parent.kind,
          input.proof.scope.parent.key,
        )
      : null;
    const existingScope = this.db
      .select({
        displayName: syncScopes.displayName,
        metadataJson: syncScopes.metadataJson,
        firstDiscoveredAt: syncScopes.firstDiscoveredAt,
      })
      .from(syncScopes)
      .where(eq(syncScopes.id, scopeId))
      .get();
    const scopeDisplayName =
      input.proof.scope.displayName === undefined
        ? (existingScope?.displayName ?? null)
        : input.proof.scope.displayName;
    const scopeMetadataJson =
      input.proof.scope.metadata === undefined
        ? (existingScope?.metadataJson ?? null)
        : safeStringifyJson(input.proof.scope.metadata);
    const scopeFirstDiscoveredAt = existingScope?.firstDiscoveredAt ?? input.proof.observedAt;

    if (input.proof.scope.parent) {
      this.db
        .insert(syncScopes)
        .values({
          id: parentScopeId!,
          platform: input.platform,
          accountKey: input.accountKey,
          scopeKind: input.proof.scope.parent.kind,
          scopeKey: input.proof.scope.parent.key,
          parentScopeId: null,
          displayName: null,
          metadataJson: null,
          firstDiscoveredAt: input.proof.observedAt,
          lastObservedAt: input.proof.observedAt,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoUpdate({
          target: [
            syncScopes.platform,
            syncScopes.accountKey,
            syncScopes.scopeKind,
            syncScopes.scopeKey,
          ],
          set: {
            lastObservedAt: input.proof.observedAt,
            updatedAt: timestamp,
          },
        })
        .run();
    }

    this.db
      .insert(syncScopes)
      .values({
        id: scopeId,
        platform: input.platform,
        accountKey: input.accountKey,
        scopeKind: input.proof.scope.kind,
        scopeKey: input.proof.scope.key,
        parentScopeId,
        displayName: scopeDisplayName,
        metadataJson: scopeMetadataJson,
        firstDiscoveredAt: scopeFirstDiscoveredAt,
        lastObservedAt: input.proof.observedAt,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: [
          syncScopes.platform,
          syncScopes.accountKey,
          syncScopes.scopeKind,
          syncScopes.scopeKey,
        ],
        set: {
          parentScopeId,
          displayName: scopeDisplayName,
          metadataJson: scopeMetadataJson,
          firstDiscoveredAt: scopeFirstDiscoveredAt,
          lastObservedAt: input.proof.observedAt,
          updatedAt: timestamp,
        },
      })
      .run();

    const proofId = buildSyncProofId(
      input.platform,
      input.accountKey,
      input.proof.scope.kind,
      input.proof.scope.key,
      input.proof.proofKind,
    );
    const existingProof = this.db
      .select({
        completedAt: syncProofs.completedAt,
      })
      .from(syncProofs)
      .where(eq(syncProofs.id, proofId))
      .get();
    const completedAt =
      input.proof.status === "complete"
        ? (existingProof?.completedAt ?? input.proof.completedAt ?? input.proof.observedAt)
        : (input.proof.completedAt ?? null);
    const proofSyncMode = input.proof.syncMode ?? null;
    const proofRunStartedAt = input.proof.runStartedAt ?? null;
    const proofFreshUntil = input.proof.freshUntil ?? null;
    const resumeCursorJson = safeStringifyJson(input.proof.resumeCursor);
    const coverageJson = safeStringifyJson(input.proof.coverage);
    const statsJson = safeStringifyJson(input.proof.stats);
    const errorJson = safeStringifyJson(input.proof.error);

    this.db
      .insert(syncProofs)
      .values({
        id: proofId,
        platform: input.platform,
        accountKey: input.accountKey,
        scopeId,
        proofKind: input.proof.proofKind,
        status: input.proof.status,
        syncMode: proofSyncMode,
        runStartedAt: proofRunStartedAt,
        lastObservedAt: input.proof.observedAt,
        completedAt,
        freshUntil: proofFreshUntil,
        resumeCursorJson,
        coverageJson,
        statsJson,
        errorJson,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: [
          syncProofs.platform,
          syncProofs.accountKey,
          syncProofs.scopeId,
          syncProofs.proofKind,
        ],
        set: {
          status: input.proof.status,
          syncMode: proofSyncMode,
          runStartedAt: proofRunStartedAt,
          lastObservedAt: input.proof.observedAt,
          completedAt,
          freshUntil: proofFreshUntil,
          resumeCursorJson,
          coverageJson,
          statsJson,
          errorJson,
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

  listMessageCountsByPlatform(): Array<{
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

  getProjectionState(options: { initialize?: boolean } = {}): ProjectionStateRow {
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
    if (options.initialize !== false) {
      this.upsertProjectionState({
        projectionWatermark: 0,
        lastProjectedAt: null,
        lastRebuildAt: null,
      });
    }
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

  listEnabledSyncPlatforms(): Platform[] {
    return this.db
      .selectDistinct({ platform: integrationStates.platform })
      .from(integrationStates)
      .where(and(eq(integrationStates.enabled, 1), eq(integrationStates.syncCapable, 1)))
      .orderBy(asc(integrationStates.platform))
      .all()
      .filter(hasKnownPlatform)
      .map((row) => row.platform);
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
      const removedSyncScopes = tx
        .delete(syncScopes)
        .where(and(eq(syncScopes.platform, platform), eq(syncScopes.accountKey, accountKey)))
        .run().changes;
      const removedRunErrors = tx
        .delete(syncRunErrors)
        .where(and(eq(syncRunErrors.platform, platform), eq(syncRunErrors.accountKey, accountKey)))
        .run().changes;
      const removedRuns = tx
        .delete(syncRuns)
        .where(and(eq(syncRuns.platform, platform), eq(syncRuns.accountKey, accountKey)))
        .run().changes;
      const removedSlackBackfillProofs =
        platform === "slack"
          ? tx
              .delete(slackBackfillProofs)
              .where(eq(slackBackfillProofs.accountKey, accountKey))
              .run().changes
          : 0;

      return (
        Number(removedSourceAccounts) +
        Number(removedCheckpoints) +
        Number(removedSyncProofs) +
        Number(removedSyncScopes) +
        Number(removedRunErrors) +
        Number(removedRuns) +
        Number(removedSlackBackfillProofs)
      );
    });
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

  getContactMemory(id: string): ContactMemoryRow | null {
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
            const recipient = toE164(handle.value) || toE164(handle.normalized_value);
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
            const recipient = toE164(handle.value) || toE164(handle.normalized_value);
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
            const recipient = toE164(handle.value) || toE164(handle.normalized_value);
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

    const directPhone = toE164(trimmed);
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
              toWhatsAppJidFromPhone(handle.value) ||
              toWhatsAppJidFromPhone(handle.normalized_value);
            if (!recipient) {
              return null;
            }
            return {
              rank: 1,
              target: recipient,
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

    const directPhone = toWhatsAppJidFromPhone(trimmed);
    if (directPhone) {
      return {
        target: directPhone,
        threadId: buildWhatsAppThreadId(directPhone),
        resolution: "passthrough",
        matchedContactIds: candidateContactIds,
        matchedName,
      };
    }

    return null;
  }

  resolveDiscordSendTarget(targetInput: string): DiscordSendResolution | null {
    const trimmed = targetInput.trim();
    if (trimmed.length === 0) {
      return null;
    }

    const exact = this.sqlite
      .prepare(
        `
        SELECT id, source_conversation_key, native_conversation_key, name
        FROM conversations
        WHERE platform = 'discord'
          AND type IN ('dm', 'group')
          AND (
            source_conversation_key = ?
            OR native_conversation_key = ?
            OR lower(name) = lower(?)
          )
        ORDER BY updated_at DESC, id ASC
        LIMIT 1
      `,
      )
      .get(trimmed, trimmed, trimmed) as
      | {
          id: string;
          source_conversation_key: string;
          native_conversation_key: string | null;
          name: string | null;
        }
      | undefined;

    if (!exact) {
      return null;
    }

    return {
      target:
        exact.native_conversation_key ??
        exact.source_conversation_key.replace(/^discord:channel:/, ""),
      threadId: exact.source_conversation_key,
      resolution:
        exact.source_conversation_key === trimmed
          ? "source_conversation_key"
          : exact.native_conversation_key === trimmed
            ? "channel_id"
            : "conversation_name",
      matchedConversationId: exact.id,
      matchedName: exact.name,
    };
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
          ma.preview_ref_json,
          ma.availability_status,
          ma.provider_metadata_json,
          ma.metadata_json,
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
            detailsJson: safeStringifyJson(input.details),
          };
        });

        tx.insert(syncRuns).values(rows).run();
      }
    });

    return runIds;
  }

  queueJob(input: {
    kind: JobKind;
    platform?: Platform | null;
    accountKey?: string | null;
    priority: number;
    trigger: string;
    checkpoint?: unknown;
    progress?: unknown;
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
      .insert(jobs)
      .values({
        id,
        kind: input.kind,
        platform: input.platform ?? null,
        accountKey: input.accountKey ?? null,
        priority: Math.trunc(input.priority),
        status: "queued",
        trigger: input.trigger,
        queuedAt,
        scheduledAt,
        startedAt: null,
        finishedAt: null,
        attempt: 0,
        ownerId: null,
        leaseExpiresAt: null,
        lastProgressAt: null,
        checkpointJson: safeStringifyJson(input.checkpoint),
        progressJson: safeStringifyJson(input.progress),
        errorJson: null,
      })
      .run();
    return id;
  }

  claimNextJob(input: { ownerId: string; leaseMs: number; kinds?: JobKind[] }): QueuedJob | null {
    const timestamp = now();
    const kindPredicate =
      input.kinds && input.kinds.length > 0 ? inArray(jobs.kind, input.kinds) : sql`1 = 1`;
    const claimablePredicate = and(
      kindPredicate,
      sql`(
        (${jobs.status} IN ('queued', 'retry_wait') AND ${jobs.scheduledAt} <= ${timestamp})
        OR (${jobs.status} = 'running' AND ${jobs.leaseExpiresAt} IS NOT NULL AND ${jobs.leaseExpiresAt} <= ${timestamp})
      )`,
    );

    return this.sqlite.transaction(() => {
      const row = this.db
        .select({
          id: jobs.id,
          kind: jobs.kind,
          platform: jobs.platform,
          account_key: jobs.accountKey,
          priority: jobs.priority,
          status: jobs.status,
          trigger: jobs.trigger,
          queued_at: jobs.queuedAt,
          scheduled_at: jobs.scheduledAt,
          started_at: jobs.startedAt,
          attempt: jobs.attempt,
          owner_id: jobs.ownerId,
          lease_expires_at: jobs.leaseExpiresAt,
          last_progress_at: jobs.lastProgressAt,
          checkpoint_json: jobs.checkpointJson,
          progress_json: jobs.progressJson,
          error_json: jobs.errorJson,
        })
        .from(jobs)
        .where(claimablePredicate)
        .orderBy(asc(jobs.priority), asc(jobs.scheduledAt), asc(jobs.queuedAt))
        .limit(1)
        .get() as QueuedJob | undefined;
      if (!row) {
        return null;
      }

      const startedAt = row.started_at ?? timestamp;
      const leaseExpiresAt = timestamp + Math.max(1, Math.trunc(input.leaseMs));
      this.db
        .update(jobs)
        .set({
          status: "running",
          ownerId: input.ownerId,
          startedAt,
          attempt: row.attempt + 1,
          leaseExpiresAt,
          lastProgressAt: row.last_progress_at ?? timestamp,
          errorJson: null,
        })
        .where(eq(jobs.id, row.id))
        .run();

      return {
        ...row,
        status: "running" as const,
        owner_id: input.ownerId,
        started_at: startedAt,
        attempt: row.attempt + 1,
        lease_expires_at: leaseExpiresAt,
        last_progress_at: row.last_progress_at ?? timestamp,
        error_json: null,
      };
    })();
  }

  updateJobProgress(
    jobId: string,
    input: {
      checkpoint?: unknown;
      progress?: unknown;
      leaseMs?: number;
    },
  ): void {
    const timestamp = now();
    this.db
      .update(jobs)
      .set({
        checkpointJson:
          input.checkpoint === undefined ? undefined : safeStringifyJson(input.checkpoint),
        progressJson: input.progress === undefined ? undefined : safeStringifyJson(input.progress),
        lastProgressAt: timestamp,
        leaseExpiresAt:
          input.leaseMs == null ? undefined : timestamp + Math.max(1, Math.trunc(input.leaseMs)),
      })
      .where(eq(jobs.id, jobId))
      .run();
  }

  completeJob(jobId: string, progress?: unknown): void {
    const timestamp = now();
    this.db
      .update(jobs)
      .set({
        status: "completed",
        finishedAt: timestamp,
        ownerId: null,
        leaseExpiresAt: null,
        lastProgressAt: timestamp,
        progressJson: progress === undefined ? undefined : safeStringifyJson(progress),
      })
      .where(eq(jobs.id, jobId))
      .run();
  }

  failJob(
    jobId: string,
    input: {
      error: unknown;
      retryAt?: number | null;
    },
  ): void {
    const timestamp = now();
    const retryAt = input.retryAt ?? null;
    this.db
      .update(jobs)
      .set({
        status: retryAt == null ? "failed" : "retry_wait",
        scheduledAt: retryAt ?? undefined,
        finishedAt: retryAt == null ? timestamp : null,
        ownerId: null,
        leaseExpiresAt: null,
        lastProgressAt: timestamp,
        errorJson: safeStringifyJson({
          message: input.error instanceof Error ? input.error.message : String(input.error),
          failedAt: timestamp,
          retryAt,
        }),
      })
      .where(eq(jobs.id, jobId))
      .run();
  }

  enqueueMessageFtsIndex(messageIds: Iterable<string>, reason: string): number {
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
              reason,
              status: "queued",
              attempt: 0,
              queuedAt: timestamp,
              updatedAt: timestamp,
              lastError: null,
            })
            .onConflictDoUpdate({
              target: messageFtsIndexQueue.messageId,
              set: {
                reason,
                status: "queued",
                updatedAt: timestamp,
                lastError: null,
              },
            })
            .run().changes;
        }
      }
    });
    return changed;
  }

  claimMessageFtsIndexBatch(limit: number): MessageFtsIndexQueueRow[] {
    const normalizedLimit = Math.max(1, Math.trunc(limit));
    const timestamp = now();
    return this.sqlite.transaction(() => {
      const rows = this.db
        .select({
          message_id: messageFtsIndexQueue.messageId,
          reason: messageFtsIndexQueue.reason,
          status: messageFtsIndexQueue.status,
          attempt: messageFtsIndexQueue.attempt,
          queued_at: messageFtsIndexQueue.queuedAt,
          updated_at: messageFtsIndexQueue.updatedAt,
          last_error: messageFtsIndexQueue.lastError,
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
          attempt: sql`${messageFtsIndexQueue.attempt} + 1`,
          updatedAt: timestamp,
          lastError: null,
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
        attempt: row.attempt + 1,
        updated_at: timestamp,
        last_error: null,
      }));
    })();
  }

  requeueStaleMessageFtsIndexing(staleBefore: number): number {
    return this.db
      .update(messageFtsIndexQueue)
      .set({
        status: "queued",
        updatedAt: now(),
        lastError: null,
      })
      .where(
        and(
          eq(messageFtsIndexQueue.status, "indexing"),
          sql`${messageFtsIndexQueue.updatedAt} < ${staleBefore}`,
        ),
      )
      .run().changes;
  }

  completeMessageFtsIndex(messageIds: Iterable<string>): number {
    const ids = [...new Set([...messageIds])];
    if (ids.length === 0) {
      return 0;
    }
    return this.db
      .delete(messageFtsIndexQueue)
      .where(inArray(messageFtsIndexQueue.messageId, ids))
      .run().changes;
  }

  failMessageFtsIndex(messageIds: Iterable<string>, error: unknown): number {
    const ids = [...new Set([...messageIds])];
    if (ids.length === 0) {
      return 0;
    }
    return this.db
      .update(messageFtsIndexQueue)
      .set({
        status: "failed",
        updatedAt: now(),
        lastError: error instanceof Error ? error.message : String(error),
      })
      .where(inArray(messageFtsIndexQueue.messageId, ids))
      .run().changes;
  }

  replaceMessageFtsIndexForIds(messageIds: Iterable<string>): number {
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
    } catch (error) {
      this.failMessageFtsIndex(messageIds, error);
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
      const claimablePredicate = and(statusPredicate, sql`${syncRuns.scheduledAt} <= ${now()}`);

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
      .values(buildRawEventValues(event))
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

  listRawEvents(): Array<{
    id: string;
    platform: Platform;
    account_key: string;
    entity_kind: RawEventEntityKind;
    event_kind: string;
    normalized_schema: string | null;
    provenance_json: string | null;
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
        normalized_schema: rawEvents.normalizedSchema,
        provenance_json: rawEvents.provenanceJson,
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
      normalized_schema: string | null;
      provenance_json: string | null;
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
    normalized_schema: string | null;
    provenance_json: string | null;
    source_version: string | null;
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
          provenance_json,
          source_version,
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
      provenance_json: string | null;
      source_version: string | null;
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
    normalized_schema: string | null;
    provenance_json: string | null;
    source_version: string | null;
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
          provenance_json,
          source_version,
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
      provenance_json: string | null;
      source_version: string | null;
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
    const cacheEntries = this.listReadyAttachmentCacheEntries();
    for (const entry of cacheEntries) {
      if (entry.cache_path) {
        rmSync(entry.cache_path, { force: true });
      }
    }

    this.db.transaction((tx) => {
      tx.run(sql.raw("DELETE FROM messages_fts"));
      tx.run(sql.raw("DELETE FROM message_fts_index_queue"));
      tx.run(sql.raw("DELETE FROM attachment_content_fts"));
      tx.delete(attachmentContent).run();
      tx.delete(attachmentCache).run();
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
