import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CUED_BROWSER_DIR } from "../config.js";
import { DEFAULT_CHAT_DB_PATH, IMessageReader } from "../adapters/imessage/reader.js";
import { listAdapterPlatforms } from "../adapters/registry.js";
import { getDefaultAccountKeyForPlatform, isRequestableIntegrationPlatform, parseIntegrationAuthState, parseIntegrationRuntimeKind, parsePlatform, REQUESTABLE_INTEGRATION_PLATFORM_VALUES, } from "../types/provider.js";
import { resolveMacOSNativeBinary } from "../workers/native-binary.js";
const REQUESTABLE_INTEGRATIONS = {
    slack: {
        connectionKind: "browser-session",
        runtimeKind: "chromium",
        launchStrategy: "chromium-auth",
        launchTarget: "https://slack.com/signin",
        displayName: "Slack",
        metadata: {
            authCapture: "localStorage.localConfig_v2 + cookie:d",
        },
    },
    linkedin: {
        connectionKind: "browser-session",
        runtimeKind: "chromium",
        launchStrategy: "chromium-auth",
        launchTarget: "https://www.linkedin.com/login",
        displayName: "LinkedIn",
        metadata: {
            authCapture: "cookies:li_at,JSESSIONID",
        },
    },
    twitter: {
        connectionKind: "browser-session",
        runtimeKind: "chromium",
        launchStrategy: "chromium-auth",
        launchTarget: "https://x.com/i/flow/login",
        displayName: "X",
        metadata: {
            authCapture: "cookies:auth_token,ct0",
        },
    },
    whatsapp: {
        connectionKind: "qr-link",
        runtimeKind: "qr_native",
        launchStrategy: "qr-native",
        launchTarget: null,
        displayName: "WhatsApp",
        metadata: {
            authCapture: "qr_pairing",
            pairingKind: "native_qr",
        },
    },
    signal: {
        connectionKind: "qr-link",
        runtimeKind: "qr_native",
        launchStrategy: "qr-native",
        launchTarget: null,
        displayName: "Signal",
        metadata: {
            authCapture: "qr_pairing",
            pairingKind: "native_qr",
        },
    },
};
function now() {
    return Date.now();
}
export function normalizeIntegrationPlatform(platform) {
    const normalized = platform.trim().toLowerCase();
    const aliased = normalized === "x" ? "twitter" : normalized;
    const parsed = parsePlatform(aliased);
    if (!parsed) {
        throw new Error(`Unsupported integration platform: ${platform}`);
    }
    return parsed;
}
export function listRequestableIntegrationPlatforms() {
    return [...REQUESTABLE_INTEGRATION_PLATFORM_VALUES];
}
function deriveRuntimeKind(row) {
    const metadata = row.metadata_json
        ? JSON.parse(row.metadata_json)
        : {};
    const fromMetadata = parseIntegrationRuntimeKind(typeof metadata.runtimeKind === "string" ? metadata.runtimeKind : null, "native");
    if (typeof metadata.runtimeKind === "string") {
        return fromMetadata;
    }
    if (row.launch_strategy === "chromium-auth")
        return "chromium";
    if (row.launch_strategy === "qr-native")
        return "qr_native";
    return "native";
}
export function getChromiumProfileDir(platform, accountKey) {
    return join(CUED_BROWSER_DIR, platform, accountKey);
}
function getRequestableIntegration(platform) {
    const normalized = normalizeIntegrationPlatform(platform);
    if (!isRequestableIntegrationPlatform(normalized)) {
        throw new Error(`Unsupported integration request: ${platform}`);
    }
    return REQUESTABLE_INTEGRATIONS[normalized];
}
function getContactsAuthState() {
    const nativeBinary = resolveMacOSNativeBinary(process.env.CUED_CONTACTS_NATIVE_BINARY);
    if (!nativeBinary) {
        return "native_helper_missing";
    }
    try {
        const stdout = execFileSync(nativeBinary, ["contacts", "status"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        const parsed = JSON.parse(stdout);
        return parseIntegrationAuthState(parsed.status);
    }
    catch {
        return "check_failed";
    }
}
function getIMessageAuthState() {
    const chatDbPath = process.env.CUED_IMESSAGE_DB_PATH ?? DEFAULT_CHAT_DB_PATH;
    if (!existsSync(chatDbPath)) {
        return "missing";
    }
    try {
        const reader = new IMessageReader(chatDbPath);
        try {
            reader.getMaxMessageRowid();
            return "authorized";
        }
        finally {
            reader.close();
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("authorization denied") || message.includes("unable to open database file")) {
            return "needs_full_disk_access";
        }
        return "blocked";
    }
}
function buildLocalIntegrationStates() {
    const chatDbPath = process.env.CUED_IMESSAGE_DB_PATH ?? DEFAULT_CHAT_DB_PATH;
    return [
        {
            platform: "contacts",
            accountKey: "local",
            displayName: "Contacts.app",
            authState: getContactsAuthState(),
            enabled: true,
            connectionKind: "native",
            runtimeKind: "native",
            syncCapable: true,
            launchStrategy: "system-settings",
            launchTarget: "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts",
            importedFrom: "local-system",
        },
        {
            platform: "imessage",
            accountKey: "local",
            displayName: "Messages",
            authState: getIMessageAuthState(),
            enabled: true,
            connectionKind: "native",
            runtimeKind: "native",
            syncCapable: true,
            launchStrategy: "system-settings",
            launchTarget: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
            importedFrom: "local-system",
            artifactPaths: existsSync(chatDbPath) ? [chatDbPath] : [],
        },
    ];
}
function resolveAccountKey(db, platform, accountKey) {
    if (accountKey) {
        return accountKey;
    }
    const matches = db.listIntegrationStates().filter((row) => row.platform === platform);
    if (matches.length === 1) {
        return matches[0].account_key;
    }
    throw new Error(matches.length === 0
        ? `Integration not found: ${platform}`
        : `Multiple accounts found for ${platform}; specify the account key`);
}
function addSupportedByDaemonMetadata(integration) {
    const supportedPlatforms = new Set(listAdapterPlatforms());
    return {
        ...integration,
        metadata: {
            ...(integration.metadata ?? {}),
            runtimeKind: integration.runtimeKind,
            supportedByDaemon: supportedPlatforms.has(integration.platform),
        },
    };
}
function getKeychainMetadata(metadata) {
    return {
        keychainService: typeof metadata?.keychainService === "string" ? metadata.keychainService : null,
        keychainAccount: typeof metadata?.keychainAccount === "string" ? metadata.keychainAccount : null,
    };
}
function deleteKeychainSecret(keychainService, keychainAccount) {
    if (!keychainService || !keychainAccount) {
        return;
    }
    try {
        execFileSync("security", ["delete-generic-password", "-s", keychainService, "-a", keychainAccount], { stdio: "ignore" });
    }
    catch {
        // Best-effort delete; missing entries are fine.
    }
}
export function summarizeAuthSessions(rows) {
    return rows.map((row) => ({
        id: row.id,
        platform: row.platform,
        accountKey: row.account_key,
        integrationStateId: row.integration_state_id,
        state: row.state,
        nativePid: row.native_pid,
        requestedAt: row.requested_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        keychainService: row.keychain_service,
        keychainAccount: row.keychain_account,
        resultSummary: row.result_summary_json
            ? JSON.parse(row.result_summary_json)
            : null,
        errorSummary: row.error_summary,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }));
}
export function summarizeIntegrationStates(db, rows) {
    return rows.map((row) => ({
        platform: row.platform,
        accountKey: row.account_key,
        displayName: row.display_name,
        authState: row.auth_state,
        enabled: row.enabled === 1,
        connectionKind: row.connection_kind,
        runtimeKind: deriveRuntimeKind(row),
        syncCapable: row.sync_capable === 1,
        launchStrategy: row.launch_strategy,
        launchTarget: row.launch_target,
        importedFrom: row.imported_from,
        artifactPaths: row.artifact_paths_json ? JSON.parse(row.artifact_paths_json) : [],
        metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
        lastSeenAt: row.last_seen_at,
        updatedAt: row.updated_at,
        latestAuthSessionId: db.getLatestAuthSession(row.platform, row.account_key)?.id ?? null,
    }));
}
export function listIntegrationStates(db) {
    return summarizeIntegrationStates(db, db.listIntegrationStates());
}
export function listAuthSessions(db, limit = 20) {
    return summarizeAuthSessions(db.listAuthSessions(limit));
}
export function getAuthSessionSummary(db, sessionId) {
    const row = db.getAuthSession(sessionId);
    return row ? summarizeAuthSessions([row])[0] : null;
}
export function getIntegrationSummary(db, platform, accountKey) {
    const normalized = normalizeIntegrationPlatform(platform);
    const resolvedAccountKey = resolveAccountKey(db, normalized, accountKey);
    const row = db.getIntegrationState(normalized, resolvedAccountKey);
    if (!row) {
        throw new Error(`Integration not found: ${normalized}/${resolvedAccountKey}`);
    }
    return summarizeIntegrationStates(db, [row])[0];
}
export function refreshManagedIntegrationStates(db) {
    const managed = buildLocalIntegrationStates().map(addSupportedByDaemonMetadata);
    for (const integration of managed) {
        const existing = db.getIntegrationState(integration.platform, integration.accountKey);
        db.upsertIntegrationState({
            platform: integration.platform,
            accountKey: integration.accountKey,
            displayName: integration.displayName,
            authState: integration.authState,
            enabled: existing ? existing.enabled === 1 : integration.enabled,
            connectionKind: integration.connectionKind,
            syncCapable: integration.syncCapable,
            launchStrategy: integration.launchStrategy ?? null,
            launchTarget: integration.launchTarget ?? null,
            importedFrom: integration.importedFrom,
            artifactPaths: integration.artifactPaths,
            metadata: integration.metadata,
        });
    }
    return {
        refreshed: managed.length,
        integrations: listIntegrationStates(db),
    };
}
export function setIntegrationEnabled(db, platform, accountKey, enabled) {
    const normalized = normalizeIntegrationPlatform(platform);
    const resolvedAccountKey = resolveAccountKey(db, normalized, accountKey);
    db.setIntegrationEnabled(normalized, resolvedAccountKey, enabled);
    return getIntegrationSummary(db, normalized, resolvedAccountKey);
}
function ensureRequestableIntegrationState(db, platform, accountKey) {
    const requested = getRequestableIntegration(platform);
    const normalized = normalizeIntegrationPlatform(platform);
    const resolvedAccountKey = accountKey ?? getDefaultAccountKeyForPlatform(normalized);
    const existing = db.getIntegrationState(normalized, resolvedAccountKey);
    const existingMetadata = existing?.metadata_json
        ? JSON.parse(existing.metadata_json)
        : {};
    const browserProfileDir = requested.runtimeKind === "chromium"
        ? getChromiumProfileDir(normalized, resolvedAccountKey)
        : null;
    const supportedByDaemon = new Set(listAdapterPlatforms()).has(normalized);
    db.upsertIntegrationState({
        platform: normalized,
        accountKey: resolvedAccountKey,
        displayName: accountKey && accountKey !== getDefaultAccountKeyForPlatform(normalized)
            ? `${requested.displayName} ${accountKey}`
            : requested.displayName,
        authState: existing?.auth_state ?? "requested",
        enabled: existing ? existing.enabled === 1 : true,
        connectionKind: requested.connectionKind,
        syncCapable: false,
        launchStrategy: requested.launchStrategy,
        launchTarget: requested.launchTarget,
        importedFrom: existing?.imported_from ?? "local-cli",
        metadata: {
            ...existingMetadata,
            ...(requested.metadata ?? {}),
            supportedByDaemon,
            authManagedBy: requested.runtimeKind === "chromium" ? "chromium-runtime" : "native-qr-runtime",
            requestedAt: existingMetadata.requestedAt ?? now(),
            runtimeKind: requested.runtimeKind,
            browserProfileDir,
        },
    });
    return getIntegrationSummary(db, normalized, resolvedAccountKey);
}
export function requestIntegrationAccess(db, platform, accountKey) {
    const integration = ensureRequestableIntegrationState(db, platform, accountKey);
    const sessionId = db.createAuthSession({
        platform: integration.platform,
        accountKey: integration.accountKey,
        integrationStateId: `${integration.platform}:${integration.accountKey}`,
        state: "requested",
    });
    db.upsertIntegrationState({
        platform: integration.platform,
        accountKey: integration.accountKey,
        displayName: integration.displayName,
        authState: "requested",
        enabled: integration.enabled,
        connectionKind: integration.connectionKind,
        syncCapable: integration.syncCapable,
        launchStrategy: integration.launchStrategy,
        launchTarget: integration.launchTarget,
        importedFrom: integration.importedFrom,
        artifactPaths: integration.artifactPaths,
        metadata: {
            ...(integration.metadata ?? {}),
            latestAuthSessionId: sessionId,
        },
    });
    return {
        integration: getIntegrationSummary(db, integration.platform, integration.accountKey),
        authSession: getAuthSessionSummary(db, sessionId),
    };
}
export const connectIntegration = requestIntegrationAccess;
export function markAuthSessionInProgress(db, sessionId, nativePid) {
    const session = db.getAuthSession(sessionId);
    if (!session) {
        throw new Error(`Auth session not found: ${sessionId}`);
    }
    db.updateAuthSessionState({
        id: sessionId,
        state: "in_progress",
        nativePid,
        startedAt: now(),
        errorSummary: null,
    });
    const integration = db.getIntegrationState(session.platform, session.account_key);
    if (integration) {
        const metadata = integration.metadata_json
            ? JSON.parse(integration.metadata_json)
            : {};
        db.upsertIntegrationState({
            platform: integration.platform,
            accountKey: integration.account_key,
            displayName: integration.display_name,
            authState: "in_progress",
            enabled: integration.enabled === 1,
            connectionKind: integration.connection_kind,
            syncCapable: integration.sync_capable === 1,
            launchStrategy: integration.launch_strategy,
            launchTarget: integration.launch_target,
            importedFrom: integration.imported_from,
            artifactPaths: integration.artifact_paths_json ? JSON.parse(integration.artifact_paths_json) : [],
            metadata: {
                ...metadata,
                latestAuthSessionId: sessionId,
            },
        });
    }
    return getAuthSessionSummary(db, sessionId);
}
export function completeAuthSession(db, sessionId, input) {
    const session = db.getAuthSession(sessionId);
    if (!session) {
        throw new Error(`Auth session not found: ${sessionId}`);
    }
    db.updateAuthSessionState({
        id: sessionId,
        state: input.state,
        finishedAt: now(),
        nativePid: null,
        keychainService: input.keychainService ?? null,
        keychainAccount: input.keychainAccount ?? null,
        resultSummary: input.resultSummary ?? null,
        errorSummary: input.errorSummary ?? null,
    });
    const integration = db.getIntegrationState(session.platform, session.account_key);
    if (!integration) {
        throw new Error(`Integration not found: ${session.platform}/${session.account_key}`);
    }
    const metadata = integration.metadata_json
        ? JSON.parse(integration.metadata_json)
        : {};
    const supportedByDaemon = new Set(listAdapterPlatforms()).has(integration.platform);
    const syncCapable = input.state === "authenticated"
        ? supportedByDaemon
        : integration.sync_capable === 1;
    db.upsertIntegrationState({
        platform: integration.platform,
        accountKey: integration.account_key,
        displayName: integration.display_name,
        authState: input.state,
        enabled: integration.enabled === 1,
        connectionKind: integration.connection_kind,
        syncCapable,
        launchStrategy: integration.launch_strategy,
        launchTarget: integration.launch_target,
        importedFrom: integration.imported_from,
        artifactPaths: integration.artifact_paths_json ? JSON.parse(integration.artifact_paths_json) : [],
        metadata: {
            ...metadata,
            latestAuthSessionId: sessionId,
            keychainService: input.keychainService ?? null,
            keychainAccount: input.keychainAccount ?? null,
            authenticatedAt: input.state === "authenticated" ? now() : null,
            authResult: input.resultSummary ?? null,
            lastAuthError: input.errorSummary ?? null,
        },
    });
    return {
        authSession: getAuthSessionSummary(db, sessionId),
        integration: getIntegrationSummary(db, session.platform, session.account_key),
    };
}
export function disconnectIntegration(db, platform, accountKey) {
    const integration = getIntegrationSummary(db, platform, accountKey);
    const keychain = getKeychainMetadata(integration.metadata);
    deleteKeychainSecret(keychain.keychainService, keychain.keychainAccount);
    db.upsertIntegrationState({
        platform: integration.platform,
        accountKey: integration.accountKey,
        displayName: integration.displayName,
        authState: "cancelled",
        enabled: false,
        connectionKind: integration.connectionKind,
        syncCapable: integration.syncCapable,
        launchStrategy: integration.launchStrategy,
        launchTarget: integration.launchTarget,
        importedFrom: integration.importedFrom,
        artifactPaths: integration.artifactPaths,
        metadata: {
            ...(integration.metadata ?? {}),
            keychainService: null,
            keychainAccount: null,
            authResult: null,
            authenticatedAt: null,
            lastAuthError: null,
            disconnectedAt: now(),
        },
    });
    return getIntegrationSummary(db, integration.platform, integration.accountKey);
}
export function buildIntegrationStatus(db) {
    return {
        integrations: listIntegrationStates(db),
        authSessions: listAuthSessions(db, 20),
    };
}
export function launchIntegration(db, platform, accountKey) {
    const integration = getIntegrationSummary(db, platform, accountKey);
    if (!integration.launchTarget) {
        return {
            launched: false,
            integration,
            command: null,
        };
    }
    if (integration.launchStrategy === "chromium-auth" || integration.launchStrategy === "qr-native") {
        return {
            launched: false,
            integration,
            command: null,
        };
    }
    execFileSync("open", [integration.launchTarget], { stdio: "ignore" });
    return {
        launched: true,
        integration,
        command: ["open", integration.launchTarget],
    };
}
export function getPlatformRuntimeDefaults(platform) {
    const runtimeKind = platform === "contacts" || platform === "imessage"
        ? "native"
        : platform === "signal" || platform === "whatsapp"
            ? "qr_native"
            : "chromium";
    return {
        runtimeKind,
        accountKey: getDefaultAccountKeyForPlatform(platform),
    };
}
//# sourceMappingURL=service.js.map