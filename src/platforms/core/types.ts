export const PLATFORM_VALUES = [
  "contacts",
  "discord",
  "gmail",
  "imessage",
  "linkedin",
  "signal",
  "slack",
  "whatsapp",
] as const;
export type Platform = (typeof PLATFORM_VALUES)[number];

export const HOST_OS_VALUES = ["macos", "windows", "linux"] as const;
export type HostOS = (typeof HOST_OS_VALUES)[number];

export const PLATFORM_PERMISSION_REQUIREMENT_VALUES = ["contacts", "full_disk_access"] as const;
export type PlatformPermissionRequirement = (typeof PLATFORM_PERMISSION_REQUIREMENT_VALUES)[number];

export const PLATFORM_HELPER_REQUIREMENT_VALUES = [
  "signal_cli",
  "slack_helper",
  "whatsapp_helper",
] as const;
export type PlatformHelperRequirement = (typeof PLATFORM_HELPER_REQUIREMENT_VALUES)[number];

export const PLATFORM_FEATURE_VALUES = [
  "send",
  "receive",
  "realtime_ingest",
  "full_history_sync",
  "message_edits",
  "deletes",
  "reactions",
  "threads_replies",
  "read_receipts",
  "attachments",
  "contact_sync",
] as const;
export type PlatformFeature = (typeof PLATFORM_FEATURE_VALUES)[number];

export const PLATFORM_FEATURE_SUPPORT_VALUES = ["yes", "partial", "no"] as const;
export type PlatformFeatureSupport = (typeof PLATFORM_FEATURE_SUPPORT_VALUES)[number];

type PlatformDefinition = {
  adapter: boolean;
  defaultAccountKey: "default" | "local";
  supportsMultipleAccounts: boolean;
  requestableIntegration: boolean;
  requestableOrder?: number;
  supportedHostOs: readonly HostOS[];
  onboardingVisible: boolean;
  permissionRequirements: readonly PlatformPermissionRequirement[];
  helperRequirements: readonly PlatformHelperRequirement[];
};

export const PLATFORM_DEFINITIONS = {
  contacts: {
    adapter: true,
    defaultAccountKey: "local",
    supportsMultipleAccounts: false,
    requestableIntegration: false,
    supportedHostOs: ["macos"],
    onboardingVisible: true,
    permissionRequirements: ["contacts"],
    helperRequirements: [],
  },
  gmail: {
    adapter: true,
    defaultAccountKey: "default",
    supportsMultipleAccounts: true,
    requestableIntegration: false,
    requestableOrder: 2,
    supportedHostOs: ["macos", "windows", "linux"],
    onboardingVisible: false,
    permissionRequirements: [],
    helperRequirements: [],
  },
  imessage: {
    adapter: true,
    defaultAccountKey: "local",
    supportsMultipleAccounts: false,
    requestableIntegration: false,
    supportedHostOs: ["macos"],
    onboardingVisible: true,
    permissionRequirements: ["full_disk_access"],
    helperRequirements: [],
  },
  discord: {
    adapter: true,
    defaultAccountKey: "default",
    supportsMultipleAccounts: false,
    requestableIntegration: true,
    requestableOrder: 3,
    supportedHostOs: ["macos", "windows", "linux"],
    onboardingVisible: true,
    permissionRequirements: [],
    helperRequirements: [],
  },
  linkedin: {
    adapter: true,
    defaultAccountKey: "default",
    supportsMultipleAccounts: false,
    requestableIntegration: true,
    requestableOrder: 4,
    supportedHostOs: ["macos", "windows", "linux"],
    onboardingVisible: true,
    permissionRequirements: [],
    helperRequirements: [],
  },
  signal: {
    adapter: true,
    defaultAccountKey: "default",
    supportsMultipleAccounts: false,
    requestableIntegration: true,
    requestableOrder: 6,
    supportedHostOs: ["macos", "windows", "linux"],
    onboardingVisible: true,
    permissionRequirements: [],
    helperRequirements: ["signal_cli"],
  },
  slack: {
    adapter: true,
    defaultAccountKey: "default",
    supportsMultipleAccounts: true,
    requestableIntegration: true,
    requestableOrder: 1,
    supportedHostOs: ["macos", "windows", "linux"],
    onboardingVisible: true,
    permissionRequirements: [],
    helperRequirements: ["slack_helper"],
  },
  whatsapp: {
    adapter: true,
    defaultAccountKey: "default",
    supportsMultipleAccounts: false,
    requestableIntegration: true,
    requestableOrder: 5,
    supportedHostOs: ["macos", "windows", "linux"],
    onboardingVisible: true,
    permissionRequirements: [],
    helperRequirements: ["whatsapp_helper"],
  },
} as const satisfies Record<Platform, PlatformDefinition>;

export const PLATFORM_FEATURE_MATRIX = {
  contacts: {
    send: "no",
    receive: "no",
    realtime_ingest: "yes",
    full_history_sync: "yes",
    message_edits: "no",
    deletes: "no",
    reactions: "no",
    threads_replies: "no",
    read_receipts: "no",
    attachments: "no",
    contact_sync: "yes",
  },
  gmail: {
    send: "no",
    receive: "yes",
    realtime_ingest: "partial",
    full_history_sync: "yes",
    message_edits: "no",
    deletes: "partial",
    reactions: "no",
    threads_replies: "yes",
    read_receipts: "no",
    attachments: "partial",
    contact_sync: "partial",
  },
  imessage: {
    send: "no",
    receive: "yes",
    realtime_ingest: "yes",
    full_history_sync: "yes",
    message_edits: "no",
    deletes: "no",
    reactions: "yes",
    threads_replies: "no",
    read_receipts: "partial",
    attachments: "yes",
    contact_sync: "partial",
  },
  discord: {
    send: "yes",
    receive: "yes",
    realtime_ingest: "yes",
    full_history_sync: "no",
    message_edits: "no",
    deletes: "no",
    reactions: "no",
    threads_replies: "partial",
    read_receipts: "no",
    attachments: "yes",
    contact_sync: "partial",
  },
  linkedin: {
    send: "no",
    receive: "yes",
    realtime_ingest: "yes",
    full_history_sync: "partial",
    message_edits: "yes",
    deletes: "yes",
    reactions: "yes",
    threads_replies: "yes",
    read_receipts: "partial",
    attachments: "yes",
    contact_sync: "yes",
  },
  signal: {
    send: "yes",
    receive: "yes",
    realtime_ingest: "yes",
    full_history_sync: "no",
    message_edits: "no",
    deletes: "no",
    reactions: "no",
    threads_replies: "no",
    read_receipts: "no",
    attachments: "yes",
    contact_sync: "partial",
  },
  slack: {
    send: "no",
    receive: "yes",
    realtime_ingest: "yes",
    full_history_sync: "yes",
    message_edits: "partial",
    deletes: "no",
    reactions: "partial",
    threads_replies: "yes",
    read_receipts: "no",
    attachments: "yes",
    contact_sync: "yes",
  },
  whatsapp: {
    send: "yes",
    receive: "yes",
    realtime_ingest: "yes",
    full_history_sync: "yes",
    message_edits: "no",
    deletes: "no",
    reactions: "no",
    threads_replies: "no",
    read_receipts: "partial",
    attachments: "yes",
    contact_sync: "partial",
  },
} as const satisfies Record<Platform, Record<PlatformFeature, PlatformFeatureSupport>>;

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
    (PLATFORM_DEFINITIONS[left].requestableOrder ?? Number.MAX_SAFE_INTEGER) -
    (PLATFORM_DEFINITIONS[right].requestableOrder ?? Number.MAX_SAFE_INTEGER),
);

export const SYNC_MODE_VALUES = ["full", "incremental"] as const;
export type SyncMode = (typeof SYNC_MODE_VALUES)[number];

export const SYNC_RUN_TYPE_VALUES = ["sync", "sync_resume", "project", "rebuild"] as const;
export type SyncRunType = (typeof SYNC_RUN_TYPE_VALUES)[number];

export const SYNC_RUN_STATUS_VALUES = [
  "queued",
  "ingesting",
  "projecting",
  "completed",
  "failed",
] as const;
export type SyncRunStatus = (typeof SYNC_RUN_STATUS_VALUES)[number];

export const RAW_EVENT_ENTITY_KIND_VALUES = [
  "contact",
  "conversation",
  "call",
  "message",
  "reaction",
  "participant",
  "timeline_event",
] as const;
export type RawEventEntityKind = (typeof RAW_EVENT_ENTITY_KIND_VALUES)[number];

export const CONTACT_KIND_VALUES = ["person"] as const;
export type ContactKind = (typeof CONTACT_KIND_VALUES)[number];

export const CONVERSATION_TYPE_VALUES = ["dm", "group"] as const;
export type ConversationType = (typeof CONVERSATION_TYPE_VALUES)[number];

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
  "needs_auth",
  "needs_full_disk_access",
  "not_determined",
  "outdated",
  "requested",
  "unknown",
] as const;
export type IntegrationAuthState = (typeof INTEGRATION_AUTH_STATE_VALUES)[number];

export const CONNECTION_KIND_VALUES = [
  "browser-session",
  "local-cli",
  "native",
  "qr-link",
] as const;
export type ConnectionKind = (typeof CONNECTION_KIND_VALUES)[number];

export const INTEGRATION_LAUNCH_STRATEGY_VALUES = [
  "chromium-auth",
  "native-auth",
  "qr-native",
  "system-settings",
] as const;
export type IntegrationLaunchStrategy = (typeof INTEGRATION_LAUNCH_STRATEGY_VALUES)[number];

export const INTEGRATION_RUNTIME_KIND_VALUES = [
  "chromium",
  "native",
  "oauth",
  "qr_native",
] as const;
export type IntegrationRuntimeKind = (typeof INTEGRATION_RUNTIME_KIND_VALUES)[number];

export const AUTH_SESSION_STATE_VALUES = [
  "requested",
  "in_progress",
  "authenticated",
  "failed",
  "cancelled",
] as const;
export type AuthSessionState = (typeof AUTH_SESSION_STATE_VALUES)[number];

const platformSet = new Set<string>(PLATFORM_VALUES);
const adapterPlatformSet = new Set<string>(ADAPTER_PLATFORM_VALUES);
const requestableIntegrationPlatformSet = new Set<string>(REQUESTABLE_INTEGRATION_PLATFORM_VALUES);
const integrationAuthStateSet = new Set<string>(INTEGRATION_AUTH_STATE_VALUES);
const integrationRuntimeKindSet = new Set<string>(INTEGRATION_RUNTIME_KIND_VALUES);
const hostOsSet = new Set<string>(HOST_OS_VALUES);

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

export function isHostOS(value: string): value is HostOS {
  return hostOsSet.has(value);
}

export function parseHostOS(value: string | null | undefined): HostOS | null {
  return value && isHostOS(value) ? value : null;
}

export function getDefaultAccountKeyForPlatform(platform: Platform): string {
  return PLATFORM_DEFINITIONS[platform].defaultAccountKey;
}

export function platformSupportsMultipleAccounts(platform: Platform): boolean {
  return PLATFORM_DEFINITIONS[platform].supportsMultipleAccounts;
}

export function getSupportedHostOsForPlatform(platform: Platform): readonly HostOS[] {
  return PLATFORM_DEFINITIONS[platform].supportedHostOs;
}

export function isPlatformSupportedOnHost(platform: Platform, hostOs: HostOS): boolean {
  return (PLATFORM_DEFINITIONS[platform].supportedHostOs as readonly HostOS[]).includes(hostOs);
}

export function isOnboardingVisiblePlatform(platform: Platform): boolean {
  return PLATFORM_DEFINITIONS[platform].onboardingVisible;
}

export function getPlatformPermissionRequirements(
  platform: Platform,
): readonly PlatformPermissionRequirement[] {
  return PLATFORM_DEFINITIONS[platform].permissionRequirements;
}

export function getPlatformHelperRequirements(
  platform: Platform,
): readonly PlatformHelperRequirement[] {
  return PLATFORM_DEFINITIONS[platform].helperRequirements;
}

export function getPlatformFeatureSupport(
  platform: Platform,
  feature: PlatformFeature,
): PlatformFeatureSupport {
  return PLATFORM_FEATURE_MATRIX[platform][feature];
}

export function getPlatformFeatureMatrixRow(
  platform: Platform,
): Readonly<Record<PlatformFeature, PlatformFeatureSupport>> {
  return PLATFORM_FEATURE_MATRIX[platform];
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
