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
  subtype?: string | null;
  service?: string | null;
  topic?: string | null;
  unreadCount?: number | null;
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

export type RawEventPayload =
  | ContactObservationPayload
  | ConversationObservationPayload
  | MessagePayload
  | ReactionPayload
  | TimelineEventPayload
  | Record<string, unknown>;

export interface SourceAccountInput {
  platform: Platform;
  accountKey: string;
  displayName: string;
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
  sourceVersion?: string | null;
}

const contactFieldNameSet = new Set<string>(CONTACT_FIELD_NAME_VALUES);

export function parseConversationType(value: string): ConversationType {
  return value === "group" ? "group" : "dm";
}

export function isContactFieldName(value: string): value is ContactFieldName {
  return contactFieldNameSet.has(value);
}
