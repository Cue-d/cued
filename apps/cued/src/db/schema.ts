import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  AUTH_SESSION_STATE_VALUES,
  CONNECTION_KIND_VALUES,
  CONTACT_FIELD_NAME_VALUES,
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

export const contactObservations = sqliteTable("contact_observations", {
  id: text("id").primaryKey(),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  accountKey: text("account_key").notNull(),
  sourceEntityKey: text("source_entity_key").notNull(),
  observedAt: integer("observed_at").notNull(),
  fieldsJson: text("fields_json").notNull(),
  handlesJson: text("handles_json").notNull(),
  rawEventId: text("raw_event_id"),
});

export const conversationObservations = sqliteTable("conversation_observations", {
  id: text("id").primaryKey(),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  accountKey: text("account_key").notNull(),
  sourceConversationKey: text("source_conversation_key").notNull(),
  observedAt: integer("observed_at").notNull(),
  fieldsJson: text("fields_json").notNull(),
  rawEventId: text("raw_event_id"),
});

export const messageEvents = sqliteTable("message_events", {
  id: text("id").primaryKey(),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  accountKey: text("account_key").notNull(),
  sourceMessageKey: text("source_message_key").notNull(),
  sourceConversationKey: text("source_conversation_key").notNull(),
  eventType: text("event_type").notNull(),
  eventAt: integer("event_at").notNull(),
  senderSourceKey: text("sender_source_key"),
  contentOriginal: text("content_original"),
  contentCurrent: text("content_current"),
  statusDelivery: text("status_delivery"),
  deleted: integer("deleted").notNull(),
  edited: integer("edited").notNull(),
  metadataJson: text("metadata_json"),
  rawEventId: text("raw_event_id"),
});

export const messageReactions = sqliteTable("message_reactions", {
  id: text("id").primaryKey(),
  messageId: text("message_id"),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  sourceReactionKey: text("source_reaction_key").notNull(),
  emoji: text("emoji").notNull(),
  reactorContactId: text("reactor_contact_id"),
  reactorSourceKey: text("reactor_source_key"),
  isActive: integer("is_active").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  rawEventId: text("raw_event_id"),
});

export const participantEvents = sqliteTable("participant_events", {
  id: text("id").primaryKey(),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  accountKey: text("account_key").notNull(),
  sourceConversationKey: text("source_conversation_key").notNull(),
  participantSourceKey: text("participant_source_key").notNull(),
  eventType: text("event_type").notNull(),
  eventAt: integer("event_at").notNull(),
  metadataJson: text("metadata_json"),
  rawEventId: text("raw_event_id"),
});

export const contacts = sqliteTable("contacts", {
  id: text("id").primaryKey(),
  kind: textEnum("kind", CONTACT_KIND_VALUES).notNull(),
  preferredDisplayName: text("preferred_display_name"),
  preferredPhotoUrl: text("preferred_photo_url"),
  preferredCompany: text("preferred_company"),
  archived: integer("archived").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const contactHandles = sqliteTable("contact_handles", {
  id: text("id").primaryKey(),
  contactId: text("contact_id").notNull(),
  handleType: text("handle_type").notNull(),
  value: text("value").notNull(),
  normalizedValue: text("normalized_value").notNull(),
  platformScope: textEnum("platform_scope", PLATFORM_VALUES),
  accountScope: text("account_scope"),
  isDeterministicKey: integer("is_deterministic_key").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const contactFieldValues = sqliteTable("contact_field_values", {
  id: text("id").primaryKey(),
  contactId: text("contact_id").notNull(),
  fieldName: textEnum("field_name", CONTACT_FIELD_NAME_VALUES).notNull(),
  fieldValue: text("field_value").notNull(),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  accountKey: text("account_key"),
  sourceEntityKey: text("source_entity_key"),
  priority: integer("priority").notNull(),
  observedAt: integer("observed_at").notNull(),
  isCurrentBest: integer("is_current_best").notNull(),
});

export const contactSources = sqliteTable("contact_sources", {
  id: text("id").primaryKey(),
  contactId: text("contact_id").notNull(),
  platform: textEnum("platform", PLATFORM_VALUES).notNull(),
  accountKey: text("account_key").notNull(),
  sourceEntityKey: text("source_entity_key").notNull(),
  sourceProfileUrl: text("source_profile_url"),
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
  conversationType: textEnum("conversation_type", CONVERSATION_TYPE_VALUES).notNull(),
  displayName: text("display_name"),
  topic: text("topic"),
  lastMessageAt: integer("last_message_at"),
  lastMessagePreview: text("last_message_preview"),
  unreadCount: integer("unread_count").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const conversationParticipants = sqliteTable("conversation_participants", {
  conversationId: text("conversation_id").notNull(),
  contactId: text("contact_id").notNull(),
  role: text("role"),
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
  sourceMessageKey: text("source_message_key").notNull(),
  conversationId: text("conversation_id").notNull(),
  senderContactId: text("sender_contact_id"),
  senderSourceKey: text("sender_source_key"),
  sentAt: integer("sent_at").notNull(),
  contentOriginal: text("content_original"),
  contentCurrent: text("content_current"),
  statusDelivery: text("status_delivery"),
  deliveredAt: integer("delivered_at"),
  readAt: integer("read_at"),
  editedAt: integer("edited_at"),
  deletedAt: integer("deleted_at"),
  isDeleted: integer("is_deleted").notNull(),
  isEdited: integer("is_edited").notNull(),
  hasAttachments: integer("has_attachments").notNull(),
  attachmentMetadataJson: text("attachment_metadata_json"),
  reactionCount: integer("reaction_count").notNull(),
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
