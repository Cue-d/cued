import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  AUTH_SESSION_STATE_VALUES,
  CONNECTION_KIND_VALUES,
  CONTACT_KIND_VALUES,
  CONVERSATION_TYPE_VALUES,
  INTEGRATION_AUTH_STATE_VALUES,
  INTEGRATION_LAUNCH_STRATEGY_VALUES,
  PLATFORM_VALUES,
  RAW_EVENT_ENTITY_KIND_VALUES,
  SYNC_MODE_VALUES,
  SYNC_RUN_STATUS_VALUES,
  SYNC_RUN_TYPE_VALUES,
} from "../core/types/provider.js";

function textEnum<const TValues extends readonly [string, ...string[]]>(
  name: string,
  values: TValues,
) {
  return text(name, { enum: values });
}

export const schemaMigrations = sqliteTable("schema_migrations", {
  id: text("id").primaryKey(),
  appliedAt: integer("applied_at").notNull(),
});

export const sourceAccounts = sqliteTable("source_accounts", {
  id: text("id").primaryKey(),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  accountKey: text("account_key").notNull(),
  displayName: text("display_name"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const syncCheckpoints = sqliteTable("sync_checkpoints", {
  id: text("id").primaryKey(),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  accountKey: text("account_key").notNull(),
  sourceCursorJson: text("source_cursor_json"),
  rawIngestWatermark: integer("raw_ingest_watermark").notNull(),
  syncMode: textEnum("sync_mode", SYNC_MODE_VALUES).notNull(),
  lastSuccessAt: integer("last_success_at"),
  lastErrorSummary: text("last_error_summary"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const syncProofs = sqliteTable("sync_proofs", {
  id: text("id").primaryKey(),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  accountKey: text("account_key").notNull(),
  scopeKind: text("scope_kind").notNull(),
  scopeKey: text("scope_key").notNull(),
  proofKind: text("proof_kind").notNull(),
  status: text("status").notNull(),
  lastObservedAt: integer("last_observed_at").notNull(),
  resumeCursorJson: text("resume_cursor_json"),
  coverageJson: text("coverage_json"),
  statsJson: text("stats_json"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const syncRuns = sqliteTable("sync_runs", {
  id: text("id").primaryKey(),
  platform: textEnum("platform", PLATFORM_VALUES),
  accountKey: text("account_key"),
  runType: textEnum("run_type", SYNC_RUN_TYPE_VALUES).notNull(),
  status: textEnum("status", SYNC_RUN_STATUS_VALUES).notNull(),
  trigger: text("trigger").notNull(),
  queuedAt: integer("queued_at").notNull(),
  scheduledAt: integer("scheduled_at").notNull(),
  startedAt: integer("started_at"),
  finishedAt: integer("finished_at"),
  attempt: integer("attempt").notNull(),
  ownerId: text("owner_id"),
  leaseExpiresAt: integer("lease_expires_at"),
  detailsJson: text("details_json"),
});

export const syncRunErrors = sqliteTable("sync_run_errors", {
  id: text("id").primaryKey(),
  platform: textEnum("platform", PLATFORM_VALUES),
  accountKey: text("account_key"),
  errorMessage: text("error_message").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const messageFtsIndexQueue = sqliteTable("message_fts_index_queue", {
  messageId: text("message_id").primaryKey(),
  status: text("status", { enum: ["queued", "indexing", "completed", "failed"] }).notNull(),
  queuedAt: integer("queued_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const daemonState = sqliteTable("daemon_state", {
  singletonKey: text("singleton_key").primaryKey(),
  pid: integer("pid"),
  startedAt: integer("started_at"),
  updatedAt: integer("updated_at"),
  status: text("status").notNull(),
  version: text("version"),
  detailsJson: text("details_json"),
});

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  updatedAt: integer("updated_at").notNull(),
});

export const projectionState = sqliteTable("projection_state", {
  singletonKey: text("singleton_key").primaryKey(),
  projectionWatermark: integer("projection_watermark").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const rawEvents = sqliteTable("raw_events", {
  id: text("id").primaryKey(),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  accountKey: text("account_key").notNull(),
  entityKind: textEnum("entity_kind", RAW_EVENT_ENTITY_KIND_VALUES).notNull(),
  eventKind: text("event_kind").notNull(),
  externalEntityId: text("external_entity_id"),
  conversationExternalId: text("conversation_external_id"),
  occurredAt: integer("occurred_at"),
  observedAt: integer("observed_at").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  payloadJson: text("payload_json").notNull(),
  normalizedSchema: text("normalized_schema"),
});

export const rawEventProjectionFailures = sqliteTable("raw_event_projection_failures", {
  rawEventRowId: integer("raw_event_rowid").primaryKey(),
  errorMessage: text("error_message").notNull(),
});

export const messageReactions = sqliteTable("message_reactions", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull(),
  accountKey: text("account_key").notNull(),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  emoji: text("emoji").notNull(),
  reactorSourceKey: text("reactor_source_key"),
  isActive: integer("is_active").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const contacts = sqliteTable("contacts", {
  id: text("id").primaryKey(),
  kind: textEnum("kind", CONTACT_KIND_VALUES).notNull(),
  name: text("name"),
  photoUrl: text("photo_url"),
  company: text("company"),
  archived: integer("archived").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const contactHandles = sqliteTable("contact_handles", {
  id: text("id").primaryKey(),
  contactId: text("contact_id").notNull(),
  type: text("type").notNull(),
  value: text("value").notNull(),
  normalizedValue: text("normalized_value").notNull(),
  isDeterministic: integer("is_deterministic").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const contactSources = sqliteTable("contact_sources", {
  id: text("id").primaryKey(),
  contactId: text("contact_id").notNull(),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  accountKey: text("account_key").notNull(),
  sourceEntityKey: text("source_entity_key").notNull(),
});

export const contactMergeDecisions = sqliteTable("contact_merge_decisions", {
  id: text("id").primaryKey(),
  primaryContactId: text("primary_contact_id").notNull(),
  secondaryContactId: text("secondary_contact_id").notNull(),
  canonicalContactId: text("canonical_contact_id").notNull(),
  reason: text("reason"),
  createdBy: text("created_by"),
  createdAt: integer("created_at").notNull(),
});

export const contactMemories = sqliteTable("contact_memories", {
  id: text("id").primaryKey(),
  contactId: text("contact_id").notNull(),
  body: text("body").notNull(),
  sourceKind: text("source_kind").notNull(),
  evidenceJson: text("evidence_json"),
  confidence: integer("confidence"),
  supersedesMemoryId: text("supersedes_memory_id"),
  staleAt: integer("stale_at"),
  createdBy: text("created_by"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  accountKey: text("account_key").notNull(),
  sourceConversationKey: text("source_conversation_key").notNull(),
  type: textEnum("type", CONVERSATION_TYPE_VALUES).notNull(),
  isActive: integer("is_active").notNull(),
  name: text("name"),
  participantNames: text("participant_names"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const conversationParticipants = sqliteTable("conversation_participants", {
  conversationId: text("conversation_id").notNull(),
  contactId: text("contact_id").notNull(),
  participantName: text("participant_name"),
  isSelf: integer("is_self").notNull(),
  isActive: integer("is_active").notNull(),
  sourceParticipantKey: text("source_participant_key"),
  updatedAt: integer("updated_at").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  accountKey: text("account_key").notNull(),
  platformMessageId: text("platform_message_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  senderContactId: text("sender_contact_id"),
  senderSourceKey: text("sender_source_key"),
  senderName: text("sender_name"),
  conversationName: text("conversation_name"),
  sentAt: integer("sent_at").notNull(),
  status: text("status"),
  isFromMe: integer("is_from_me").notNull(),
  content: text("content"),
  deliveredAt: integer("delivered_at"),
  readAt: integer("read_at"),
  isDeleted: integer("is_deleted").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const messageAttachments = sqliteTable("message_attachments", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull(),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  accountKey: text("account_key").notNull(),
  sourceAttachmentKey: text("source_attachment_key").notNull(),
  kind: text("kind"),
  mimeType: text("mime_type"),
  filename: text("filename"),
  title: text("title"),
  localPath: text("local_path"),
  remoteUrl: text("remote_url"),
  sizeBytes: integer("size_bytes"),
  textContent: text("text_content"),
  accessKind: text("access_kind"),
  accessRefJson: text("access_ref_json"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const attachmentCache = sqliteTable("attachment_cache", {
  id: text("id").primaryKey(),
  attachmentId: text("attachment_id").notNull(),
  variant: text("variant").notNull(),
  status: text("status").notNull(),
  cachePath: text("cache_path"),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes"),
  sha256: text("sha256"),
  fetchedAt: integer("fetched_at"),
  lastAccessedAt: integer("last_accessed_at"),
  expiresAt: integer("expires_at"),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const attachmentContent = sqliteTable("attachment_content", {
  attachmentId: text("attachment_id").primaryKey(),
  extractor: text("extractor"),
  status: text("status").notNull(),
  textContent: text("text_content"),
  mimeType: text("mime_type"),
  extractedAt: integer("extracted_at"),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const timelineEvents = sqliteTable("timeline_events", {
  id: text("id").primaryKey(),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  accountKey: text("account_key").notNull(),
  conversationId: text("conversation_id").notNull(),
  sourceEventKey: text("source_event_key").notNull(),
  eventKind: text("event_kind").notNull(),
  actorContactId: text("actor_contact_id"),
  actorSourceKey: text("actor_source_key"),
  actorName: text("actor_name"),
  subjectContactId: text("subject_contact_id"),
  subjectSourceKey: text("subject_source_key"),
  eventAt: integer("event_at").notNull(),
  text: text("text"),
  systemKind: text("system_kind"),
  callProvider: text("call_provider"),
  callDirection: text("call_direction"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const integrationStates = sqliteTable("integration_states", {
  id: text("id").primaryKey(),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  accountKey: text("account_key").notNull(),
  displayName: text("display_name"),
  authState: textEnum("auth_state", INTEGRATION_AUTH_STATE_VALUES).notNull(),
  enabled: integer("enabled").notNull(),
  connectionKind: textEnum("connection_kind", CONNECTION_KIND_VALUES).notNull(),
  syncCapable: integer("sync_capable").notNull(),
  launchStrategy: textEnum("launch_strategy", INTEGRATION_LAUNCH_STRATEGY_VALUES),
  launchTarget: text("launch_target"),
  importedFrom: text("imported_from"),
  artifactPathsJson: text("artifact_paths_json"),
  metadataJson: text("metadata_json"),
  lastSeenAt: integer("last_seen_at").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const authSessions = sqliteTable("auth_sessions", {
  id: text("id").primaryKey(),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  accountKey: text("account_key").notNull(),
  integrationStateId: text("integration_state_id").notNull(),
  state: textEnum("state", AUTH_SESSION_STATE_VALUES).notNull(),
  nativePid: integer("native_pid"),
  requestedAt: integer("requested_at").notNull(),
  startedAt: integer("started_at"),
  finishedAt: integer("finished_at"),
  keychainService: text("keychain_service"),
  keychainAccount: text("keychain_account"),
  resultSummaryJson: text("result_summary_json"),
  errorSummary: text("error_summary"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
