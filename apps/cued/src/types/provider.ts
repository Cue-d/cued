export const PLATFORM_VALUES = [
  "contacts",
  "discord",
  "fixture",
  "imessage",
  "linkedin",
  "signal",
  "slack",
  "telegram",
  "twitter",
  "whatsapp",
] as const;
export type Platform = typeof PLATFORM_VALUES[number];

type PlatformDefinition = {
  adapter: boolean;
  defaultAccountKey: "default" | "local";
  requestableIntegration: boolean;
  requestableOrder?: number;
};

export const PLATFORM_DEFINITIONS = {
  contacts: {
    adapter: true,
    defaultAccountKey: "local",
    requestableIntegration: false,
  },
  discord: {
    adapter: false,
    defaultAccountKey: "default",
    requestableIntegration: false,
  },
  fixture: {
    adapter: true,
    defaultAccountKey: "default",
    requestableIntegration: false,
  },
  imessage: {
    adapter: true,
    defaultAccountKey: "local",
    requestableIntegration: false,
  },
  linkedin: {
    adapter: false,
    defaultAccountKey: "default",
    requestableIntegration: true,
    requestableOrder: 2,
  },
  signal: {
    adapter: false,
    defaultAccountKey: "default",
    requestableIntegration: true,
    requestableOrder: 5,
  },
  slack: {
    adapter: false,
    defaultAccountKey: "default",
    requestableIntegration: true,
    requestableOrder: 1,
  },
  telegram: {
    adapter: false,
    defaultAccountKey: "default",
    requestableIntegration: false,
  },
  twitter: {
    adapter: false,
    defaultAccountKey: "default",
    requestableIntegration: true,
    requestableOrder: 3,
  },
  whatsapp: {
    adapter: false,
    defaultAccountKey: "default",
    requestableIntegration: true,
    requestableOrder: 4,
  },
} as const satisfies Record<Platform, PlatformDefinition>;

type PlatformCapabilityFlag = "adapter" | "requestableIntegration";

type PlatformsMatching<Flag extends PlatformCapabilityFlag> = {
  [Key in Platform]: (typeof PLATFORM_DEFINITIONS)[Key][Flag] extends true ? Key : never;
}[Platform];

export type AdapterPlatform = PlatformsMatching<"adapter">;
export const ADAPTER_PLATFORM_VALUES = PLATFORM_VALUES.filter(
  (platform): platform is AdapterPlatform => PLATFORM_DEFINITIONS[platform].adapter,
);

export type RequestableIntegrationPlatform = PlatformsMatching<"requestableIntegration">;
export const REQUESTABLE_INTEGRATION_PLATFORM_VALUES = PLATFORM_VALUES.filter(
  (platform): platform is RequestableIntegrationPlatform =>
    PLATFORM_DEFINITIONS[platform].requestableIntegration,
).sort(
  (left, right) =>
    (PLATFORM_DEFINITIONS[left].requestableOrder ?? Number.MAX_SAFE_INTEGER)
    - (PLATFORM_DEFINITIONS[right].requestableOrder ?? Number.MAX_SAFE_INTEGER),
);

export const SYNC_MODE_VALUES = ["full", "incremental"] as const;
export type SyncMode = typeof SYNC_MODE_VALUES[number];

export const SYNC_RUN_TYPE_VALUES = ["sync", "sync_resume", "rebuild"] as const;
export type SyncRunType = typeof SYNC_RUN_TYPE_VALUES[number];

export const SYNC_RUN_STATUS_VALUES = ["queued", "running", "completed", "failed"] as const;
export type SyncRunStatus = typeof SYNC_RUN_STATUS_VALUES[number];

export const RAW_EVENT_ENTITY_KIND_VALUES = [
  "contact",
  "conversation",
  "message",
  "reaction",
  "participant",
] as const;
export type RawEventEntityKind = typeof RAW_EVENT_ENTITY_KIND_VALUES[number];

export const CONTACT_KIND_VALUES = ["person"] as const;
export type ContactKind = typeof CONTACT_KIND_VALUES[number];

export const CONVERSATION_TYPE_VALUES = ["dm", "group"] as const;
export type ConversationType = typeof CONVERSATION_TYPE_VALUES[number];

export const MERGE_DECISION_TYPE_VALUES = ["merge", "block", "split"] as const;
export type MergeDecisionType = typeof MERGE_DECISION_TYPE_VALUES[number];

export const INTEGRATION_AUTH_STATE_VALUES = [
  "authenticated",
  "authorized",
  "blocked",
  "cancelled",
  "check_failed",
  "failed",
  "in_progress",
  "missing",
  "native_helper_missing",
  "needs_full_disk_access",
  "not_determined",
  "requested",
  "unknown",
] as const;
export type IntegrationAuthState = typeof INTEGRATION_AUTH_STATE_VALUES[number];

export const CONNECTION_KIND_VALUES = [
  "browser-session",
  "local-cli",
  "native",
  "qr-link",
] as const;
export type ConnectionKind = typeof CONNECTION_KIND_VALUES[number];

export const INTEGRATION_LAUNCH_STRATEGY_VALUES = [
  "chromium-auth",
  "native-auth",
  "qr-native",
  "system-settings",
] as const;
export type IntegrationLaunchStrategy = typeof INTEGRATION_LAUNCH_STRATEGY_VALUES[number];

export const INTEGRATION_RUNTIME_KIND_VALUES = [
  "chromium",
  "native",
  "oauth",
  "qr_native",
] as const;
export type IntegrationRuntimeKind = typeof INTEGRATION_RUNTIME_KIND_VALUES[number];

export const AUTH_SESSION_STATE_VALUES = [
  "requested",
  "in_progress",
  "authenticated",
  "failed",
  "cancelled",
] as const;
export type AuthSessionState = typeof AUTH_SESSION_STATE_VALUES[number];

export const CONTACT_FIELD_NAME_VALUES = [
  "company",
  "display_name",
  "photo_url",
] as const;
export type ContactFieldName = typeof CONTACT_FIELD_NAME_VALUES[number];

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
  contentOriginal: string;
  contentCurrent?: string;
  statusDelivery?: string | null;
  deliveredAt?: number | null;
  readAt?: number | null;
  editedAt?: number | null;
  deletedAt?: number | null;
  isEdited?: boolean;
  isDeleted?: boolean;
  hasAttachments?: boolean;
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

export type RawEventPayload =
  | ContactObservationPayload
  | ConversationObservationPayload
  | MessagePayload
  | ReactionPayload
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

const platformSet = new Set<string>(PLATFORM_VALUES);
const adapterPlatformSet = new Set<string>(ADAPTER_PLATFORM_VALUES);
const requestableIntegrationPlatformSet = new Set<string>(REQUESTABLE_INTEGRATION_PLATFORM_VALUES);
const integrationAuthStateSet = new Set<string>(INTEGRATION_AUTH_STATE_VALUES);
const contactFieldNameSet = new Set<string>(CONTACT_FIELD_NAME_VALUES);
const integrationRuntimeKindSet = new Set<string>(INTEGRATION_RUNTIME_KIND_VALUES);

export function isPlatform(value: string): value is Platform {
  return platformSet.has(value);
}

export function isAdapterPlatform(value: string): value is AdapterPlatform {
  return adapterPlatformSet.has(value);
}

export function isRequestableIntegrationPlatform(
  value: string,
): value is RequestableIntegrationPlatform {
  return requestableIntegrationPlatformSet.has(value);
}

export function parsePlatform(value: string): Platform | null {
  return isPlatform(value) ? value : null;
}

export function getDefaultAccountKeyForPlatform(platform: Platform): string {
  return PLATFORM_DEFINITIONS[platform].defaultAccountKey;
}

export function parseConversationType(value: string): ConversationType {
  return value === "group" ? "group" : "dm";
}

export function isIntegrationAuthState(value: string): value is IntegrationAuthState {
  return integrationAuthStateSet.has(value);
}

export function parseIntegrationAuthState(
  value: string | null | undefined,
  fallback: IntegrationAuthState = "unknown",
): IntegrationAuthState {
  return value && isIntegrationAuthState(value) ? value : fallback;
}

export function isIntegrationRuntimeKind(value: string): value is IntegrationRuntimeKind {
  return integrationRuntimeKindSet.has(value);
}

export function parseIntegrationRuntimeKind(
  value: string | null | undefined,
  fallback: IntegrationRuntimeKind = "native",
): IntegrationRuntimeKind {
  return value && isIntegrationRuntimeKind(value) ? value : fallback;
}

export function isContactFieldName(value: string): value is ContactFieldName {
  return contactFieldNameSet.has(value);
}
