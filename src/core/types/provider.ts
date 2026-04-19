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
  sourceProfileUrl?: string | null;
}

export interface ConversationParticipantInput {
  sourceEntityKey: string;
  isSelf?: boolean;
}

export interface ConversationObservationPayload {
  sourceConversationKey: string;
  conversationType: ConversationType;
  displayName?: string | null;
  nativeConversationKey?: string | null;
  service?: string | null;
  topic?: string | null;
  unreadCount?: number | null;
  removalReason?: string | null;
  participants: ConversationParticipantInput[];
}

export interface MessagePayload {
  sourceMessageKey: string;
  sourceConversationKey: string;
  senderSourceKey: string | null;
  sentAt: number;
  content: string;
  service?: string | null;
  status?: string | null;
  isFromMe?: boolean;
  deliveredAt?: number | null;
  readAt?: number | null;
  editedAt?: number | null;
  deletedAt?: number | null;
  replyToSourceMessageKey?: string | null;
  isEdited?: boolean;
  isDeleted?: boolean;
  attachments?: Array<Record<string, unknown>>;
}

export interface ReactionPayload {
  sourceMessageKey: string;
  sourceConversationKey: string;
  reactorSourceKey: string | null;
  emoji: string;
  reactionType?: string | null;
  timestamp: number;
  isActive: boolean;
}

export interface ParticipantPayload {
  sourceConversationKey: string;
  participantSourceKey: string;
  eventAt: number;
  isSelf?: boolean;
  role?: string | null;
  metadata?: Record<string, unknown>;
}

export interface TimelineEventPayload {
  sourceEventKey: string;
  sourceConversationKey: string;
  eventKind: string;
  actorSourceKey?: string | null;
  subjectSourceKey?: string | null;
  eventAt: number;
  text?: string | null;
  metadata?: Record<string, unknown>;
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
  providerCallType?: string | null;
  direction: CallDirection;
  medium: CallMedium;
  status: CallStatus;
  startedAt: number;
  answeredAt?: number | null;
  endedAt?: number | null;
  durationSeconds?: number | null;
  initiatorSourceKey?: string | null;
  primaryRemoteSourceKey?: string | null;
  remoteAddress?: string | null;
  remoteDisplayName?: string | null;
  disconnectedCause?: string | null;
  metadata?: Record<string, unknown>;
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

export const RAW_EVENT_ACQUISITION_MODE_VALUES = ["sync", "realtime"] as const;
export type RawEventAcquisitionMode = (typeof RAW_EVENT_ACQUISITION_MODE_VALUES)[number];

export interface RawEventProvenance {
  providerApiVersion?: string | null;
  adapterVersion?: string | null;
  acquisitionMode?: RawEventAcquisitionMode | null;
}

export interface ProviderRawEventInput<TPayload = RawEventPayload> {
  id: string;
  platform: Platform;
  accountKey: string;
  entityKind: RawEventEntityKind;
  eventKind: string;
  externalEventId?: string | null;
  externalEntityId?: string | null;
  conversationExternalId?: string | null;
  occurredAt?: number | null;
  observedAt: number;
  cursor?: unknown;
  dedupeKey: string;
  payload: TPayload;
  normalizedSchema?: string | null;
  provenance?: RawEventProvenance | null;
  sourceVersion?: string | null;
}

const contactFieldNameSet = new Set<string>(CONTACT_FIELD_NAME_VALUES);

export function buildNormalizedRawEventSchema(
  entityKind: RawEventEntityKind,
  eventKind: string,
  version = 1,
): string {
  return `${entityKind}.${eventKind}@${version}`;
}

export function normalizeRawEventProvenance(
  input: Partial<RawEventProvenance> | null | undefined,
): RawEventProvenance | null {
  const normalized: RawEventProvenance = {
    providerApiVersion: input?.providerApiVersion ?? null,
    adapterVersion: input?.adapterVersion ?? null,
    acquisitionMode: input?.acquisitionMode ?? null,
  };

  return normalized.providerApiVersion || normalized.adapterVersion || normalized.acquisitionMode
    ? normalized
    : null;
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
