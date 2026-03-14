import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  AUTH_SESSION_STATE_VALUES,
  CONNECTION_KIND_VALUES,
  CONTACT_KIND_VALUES,
  CONVERSATION_TYPE_VALUES,
  INTEGRATION_AUTH_STATE_VALUES,
  INTEGRATION_LAUNCH_STRATEGY_VALUES,
  MERGE_DECISION_TYPE_VALUES,
  PLATFORM_VALUES,
  RAW_EVENT_ENTITY_KIND_VALUES,
  SYNC_MODE_VALUES,
  SYNC_RUN_STATUS_VALUES,
  SYNC_RUN_TYPE_VALUES,
} from "../types/provider.js";

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
  status: text("status").notNull(),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const syncCheckpoints = sqliteTable("sync_checkpoints", {
  id: text("id").primaryKey(),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  accountKey: text("account_key").notNull(),
  sourceCursorJson: text("source_cursor_json"),
  rawIngestWatermark: integer("raw_ingest_watermark").notNull(),
  projectionWatermark: integer("projection_watermark").notNull(),
  syncMode: textEnum("sync_mode", SYNC_MODE_VALUES).notNull(),
  lastFullSyncAt: integer("last_full_sync_at"),
  lastSuccessAt: integer("last_success_at"),
  lastErrorAt: integer("last_error_at"),
  lastErrorSummary: text("last_error_summary"),
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
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
  detailsJson: text("details_json"),
});

export const syncRunErrors = sqliteTable("sync_run_errors", {
  id: text("id").primaryKey(),
  syncRunId: text("sync_run_id").notNull(),
  platform: textEnum("platform", PLATFORM_VALUES),
  accountKey: text("account_key"),
  errorCode: text("error_code"),
  errorMessage: text("error_message").notNull(),
  detailsJson: text("details_json"),
  createdAt: integer("created_at").notNull(),
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
  lastProjectedAt: integer("last_projected_at"),
  lastRebuildAt: integer("last_rebuild_at"),
  updatedAt: integer("updated_at").notNull(),
});

export const rawEvents = sqliteTable("raw_events", {
  id: text("id").primaryKey(),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  accountKey: text("account_key").notNull(),
  entityKind: textEnum("entity_kind", RAW_EVENT_ENTITY_KIND_VALUES).notNull(),
  eventKind: text("event_kind").notNull(),
  externalEventId: text("external_event_id"),
  externalEntityId: text("external_entity_id"),
  conversationExternalId: text("conversation_external_id"),
  occurredAt: integer("occurred_at"),
  observedAt: integer("observed_at").notNull(),
  cursorJson: text("cursor_json"),
  dedupeKey: text("dedupe_key").notNull(),
  payloadJson: text("payload_json").notNull(),
  sourceVersion: text("source_version"),
});

export const messageReactions = sqliteTable("message_reactions", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull(),
  accountKey: text("account_key").notNull(),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  sourceReactionKey: text("source_reaction_key").notNull(),
  reactionType: text("reaction_type"),
  emoji: text("emoji").notNull(),
  reactorContactId: text("reactor_contact_id"),
  reactorSourceKey: text("reactor_source_key"),
  reactorName: text("reactor_name"),
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
  platform: textEnum("platform", PLATFORM_VALUES),
  accountKey: text("account_key"),
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
  profileUrl: text("profile_url"),
  firstSeenAt: integer("first_seen_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  metadataJson: text("metadata_json"),
});

export const contactMergeDecisions = sqliteTable("contact_merge_decisions", {
  id: text("id").primaryKey(),
  decisionType: textEnum("decision_type", MERGE_DECISION_TYPE_VALUES).notNull(),
  leftContactId: text("left_contact_id"),
  rightContactId: text("right_contact_id"),
  canonicalContactId: text("canonical_contact_id"),
  reason: text("reason"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  accountKey: text("account_key").notNull(),
  sourceConversationKey: text("source_conversation_key").notNull(),
  nativeConversationKey: text("native_conversation_key"),
  type: textEnum("type", CONVERSATION_TYPE_VALUES).notNull(),
  subtype: text("subtype"),
  service: text("service"),
  name: text("name"),
  topic: text("topic"),
  participantNames: text("participant_names"),
  lastMessageId: text("last_message_id"),
  lastMessageAt: integer("last_message_at"),
  lastMessagePreview: text("last_message_preview"),
  unreadCount: integer("unread_count").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const conversationParticipants = sqliteTable("conversation_participants", {
  conversationId: text("conversation_id").notNull(),
  contactId: text("contact_id").notNull(),
  participantName: text("participant_name"),
  role: text("role"),
  isSelf: integer("is_self").notNull(),
  joinedAt: integer("joined_at"),
  leftAt: integer("left_at"),
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
  service: text("service"),
  status: text("status"),
  isFromMe: integer("is_from_me").notNull(),
  content: text("content"),
  deliveredAt: integer("delivered_at"),
  readAt: integer("read_at"),
  editedAt: integer("edited_at"),
  deletedAt: integer("deleted_at"),
  replyToMessageId: text("reply_to_message_id"),
  isDeleted: integer("is_deleted").notNull(),
  isEdited: integer("is_edited").notNull(),
  attachmentCount: integer("attachment_count").notNull(),
  reactionCount: integer("reaction_count").notNull(),
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
  previewRefJson: text("preview_ref_json"),
  availabilityStatus: text("availability_status"),
  providerMetadataJson: text("provider_metadata_json"),
  metadataJson: text("metadata_json"),
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
  eventAt: integer("event_at").notNull(),
  text: text("text"),
  metadataJson: text("metadata_json"),
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

export const outboundMessages = sqliteTable("outbound_messages", {
  id: text("id").primaryKey(),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  accountKey: text("account_key").notNull(),
  target: text("target").notNull(),
  threadId: text("thread_id"),
  text: text("text").notNull(),
  status: text("status").notNull(),
  attemptCount: integer("attempt_count").notNull(),
  scheduledFor: integer("scheduled_for").notNull(),
  startedAt: integer("started_at"),
  finishedAt: integer("finished_at"),
  lastError: text("last_error"),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
