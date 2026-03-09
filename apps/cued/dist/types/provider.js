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
];
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
        adapter: true,
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
};
export const ADAPTER_PLATFORM_VALUES = PLATFORM_VALUES.filter((platform) => PLATFORM_DEFINITIONS[platform].adapter);
export const REQUESTABLE_INTEGRATION_PLATFORM_VALUES = PLATFORM_VALUES.filter((platform) => PLATFORM_DEFINITIONS[platform].requestableIntegration).sort((left, right) => (PLATFORM_DEFINITIONS[left].requestableOrder ?? Number.MAX_SAFE_INTEGER)
    - (PLATFORM_DEFINITIONS[right].requestableOrder ?? Number.MAX_SAFE_INTEGER));
export const SYNC_MODE_VALUES = ["full", "incremental"];
export const SYNC_RUN_TYPE_VALUES = ["sync", "sync_resume", "rebuild"];
export const SYNC_RUN_STATUS_VALUES = ["queued", "running", "completed", "failed"];
export const RAW_EVENT_ENTITY_KIND_VALUES = [
    "contact",
    "conversation",
    "message",
    "reaction",
    "participant",
];
export const CONTACT_KIND_VALUES = ["person"];
export const CONVERSATION_TYPE_VALUES = ["dm", "group"];
export const MERGE_DECISION_TYPE_VALUES = ["merge", "block", "split"];
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
];
export const CONNECTION_KIND_VALUES = [
    "browser-session",
    "local-cli",
    "native",
    "qr-link",
];
export const INTEGRATION_LAUNCH_STRATEGY_VALUES = [
    "chromium-auth",
    "native-auth",
    "qr-native",
    "system-settings",
];
export const INTEGRATION_RUNTIME_KIND_VALUES = [
    "chromium",
    "native",
    "oauth",
    "qr_native",
];
export const AUTH_SESSION_STATE_VALUES = [
    "requested",
    "in_progress",
    "authenticated",
    "failed",
    "cancelled",
];
export const CONTACT_FIELD_NAME_VALUES = [
    "company",
    "display_name",
    "photo_url",
];
const platformSet = new Set(PLATFORM_VALUES);
const adapterPlatformSet = new Set(ADAPTER_PLATFORM_VALUES);
const requestableIntegrationPlatformSet = new Set(REQUESTABLE_INTEGRATION_PLATFORM_VALUES);
const integrationAuthStateSet = new Set(INTEGRATION_AUTH_STATE_VALUES);
const contactFieldNameSet = new Set(CONTACT_FIELD_NAME_VALUES);
const integrationRuntimeKindSet = new Set(INTEGRATION_RUNTIME_KIND_VALUES);
export function isPlatform(value) {
    return platformSet.has(value);
}
export function isAdapterPlatform(value) {
    return adapterPlatformSet.has(value);
}
export function isRequestableIntegrationPlatform(value) {
    return requestableIntegrationPlatformSet.has(value);
}
export function parsePlatform(value) {
    return isPlatform(value) ? value : null;
}
export function getDefaultAccountKeyForPlatform(platform) {
    return PLATFORM_DEFINITIONS[platform].defaultAccountKey;
}
export function parseConversationType(value) {
    return value === "group" ? "group" : "dm";
}
export function isIntegrationAuthState(value) {
    return integrationAuthStateSet.has(value);
}
export function parseIntegrationAuthState(value, fallback = "unknown") {
    return value && isIntegrationAuthState(value) ? value : fallback;
}
export function isIntegrationRuntimeKind(value) {
    return integrationRuntimeKindSet.has(value);
}
export function parseIntegrationRuntimeKind(value, fallback = "native") {
    return value && isIntegrationRuntimeKind(value) ? value : fallback;
}
export function isContactFieldName(value) {
    return contactFieldNameSet.has(value);
}
//# sourceMappingURL=provider.js.map