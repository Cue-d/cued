import type { ConversationType, Platform, RawEventEntityKind } from "../../platforms/core/types.js";

export * from "../../platforms/core/types.js";

export const CONTACT_FIELD_NAME_VALUES = ["company", "display_name", "photo_url"] as const;
export type ContactFieldName = (typeof CONTACT_FIELD_NAME_VALUES)[number];

export type ContactFields = Partial<Record<ContactFieldName, string | null | undefined>>;

export interface ContactHandleInput {
  type: string;
  value: string;
  deterministic?: boolean;
}

export interface ContactObservationPayload {
  sourceEntityKey: string;
  fields: ContactFields;
  handles: ContactHandleInput[];
}

export interface ConversationParticipantInput {
  sourceEntityKey: string;
  isSelf?: boolean;
}

export interface ConversationObservationPayload {
  sourceConversationKey: string;
  conversationType: ConversationType;
  displayName?: string | null;
  participants: ConversationParticipantInput[];
}

export interface MessagePayload {
  sourceMessageKey: string;
  sourceConversationKey: string;
  senderSourceKey: string | null;
  sentAt: number;
  content: string;
  status?: string | null;
  isFromMe?: boolean;
  deliveredAt?: number | null;
  readAt?: number | null;
  isDeleted?: boolean;
  attachments?: Array<Record<string, unknown>>;
}

export interface ReactionPayload {
  sourceMessageKey: string;
  sourceConversationKey: string;
  reactorSourceKey: string | null;
  emoji: string;
  timestamp: number;
  isActive: boolean;
}

export interface ParticipantPayload {
  sourceConversationKey: string;
  participantSourceKey: string;
  isSelf?: boolean;
}

export interface TimelineEventPayload {
  sourceEventKey: string;
  sourceConversationKey: string;
  eventKind: string;
  actorSourceKey?: string | null;
  subjectSourceKey?: string | null;
  eventAt: number;
  text?: string | null;
  systemKind?: string | null;
}

export const CALL_PROVIDER_VALUES = [
  "telephony",
  "facetime",
  "whatsapp",
  "signal",
  "slack",
  "linkedin",
  "unknown",
] as const;
export type CallProvider = (typeof CALL_PROVIDER_VALUES)[number];

export const CALL_DIRECTION_VALUES = ["incoming", "outgoing", "unknown"] as const;
export type CallDirection = (typeof CALL_DIRECTION_VALUES)[number];

export const CALL_MEDIUM_VALUES = ["audio", "video", "screen_share", "unknown"] as const;
export type CallMedium = (typeof CALL_MEDIUM_VALUES)[number];

export const CALL_STATUS_VALUES = [
  "completed",
  "missed",
  "declined",
  "canceled",
  "blocked",
  "failed",
  "ongoing",
  "unknown",
] as const;
export type CallStatus = (typeof CALL_STATUS_VALUES)[number];

export interface CallPayload {
  sourceCallKey: string;
  sourceConversationKey: string;
  provider: CallProvider;
  direction: CallDirection;
  medium: CallMedium;
  status: CallStatus;
  startedAt: number;
  durationSeconds?: number | null;
  initiatorSourceKey?: string | null;
  primaryRemoteSourceKey?: string | null;
}

export type RawEventPayload =
  | ContactObservationPayload
  | ConversationObservationPayload
  | CallPayload
  | MessagePayload
  | ReactionPayload
  | ParticipantPayload
  | TimelineEventPayload
  | Record<string, unknown>;

export interface SourceAccountInput {
  platform: Platform;
  accountKey: string;
  displayName: string;
}

export const SYNC_PROOF_STATUS_VALUES = [
  "pending",
  "running",
  "complete",
  "partial",
  "blocked",
  "failed",
  "stale",
] as const;
export type SyncProofStatus = (typeof SYNC_PROOF_STATUS_VALUES)[number];

export const SYNC_SCOPE_KIND_VALUES = [
  "account",
  "folder",
  "label",
  "conversation",
  "thread",
] as const;
export type StandardSyncScopeKind = (typeof SYNC_SCOPE_KIND_VALUES)[number];
export type SyncScopeKind = StandardSyncScopeKind | (string & {});

export const SYNC_PROOF_KIND_VALUES = [
  "discovery",
  "messages",
  "replies",
  "attachments",
  "participants",
] as const;
export type StandardSyncProofKind = (typeof SYNC_PROOF_KIND_VALUES)[number];
export type SyncProofKind = StandardSyncProofKind | (string & {});

export interface SyncScopeInput {
  kind: SyncScopeKind;
  key: string;
}

export interface SyncProofInput {
  scope: SyncScopeInput;
  proofKind: SyncProofKind;
  status: SyncProofStatus;
  observedAt: number;
  resumeCursor?: unknown;
  coverage?: Record<string, unknown> | null;
  stats?: Record<string, unknown> | null;
}

export const RAW_EVENT_ACQUISITION_MODE_VALUES = ["sync", "realtime"] as const;
export type RawEventAcquisitionMode = (typeof RAW_EVENT_ACQUISITION_MODE_VALUES)[number];

export interface RawEventProvenance {
  acquisitionMode?: RawEventAcquisitionMode | null;
}

export interface ProviderRawEventInput<TPayload = RawEventPayload> {
  id: string;
  platform: Platform;
  accountKey: string;
  entityKind: RawEventEntityKind;
  eventKind: string;
  externalEntityId?: string | null;
  conversationExternalId?: string | null;
  occurredAt?: number | null;
  observedAt: number;
  dedupeKey: string;
  payload: TPayload;
  normalizedSchema?: string | null;
  provenance?: RawEventProvenance | null;
}

const contactFieldNameSet = new Set<string>(CONTACT_FIELD_NAME_VALUES);

export function buildNormalizedRawEventSchema(
  entityKind: RawEventEntityKind,
  eventKind: string,
  version = 1,
): string {
  return `${entityKind}.${eventKind}@${version}`;
}

export function resolveRawEventNormalizedSchema(
  input: Pick<ProviderRawEventInput, "entityKind" | "eventKind" | "normalizedSchema">,
): string {
  return (
    input.normalizedSchema?.trim() ||
    buildNormalizedRawEventSchema(input.entityKind, input.eventKind)
  );
}

export function parseConversationType(value: string): ConversationType {
  return value === "group" ? "group" : "dm";
}

export function isContactFieldName(value: string): value is ContactFieldName {
  return contactFieldNameSet.has(value);
}
