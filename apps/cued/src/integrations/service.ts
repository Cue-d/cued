import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CUED_BROWSER_DIR } from "../config.js";
import { DEFAULT_CHAT_DB_PATH, IMessageReader } from "../adapters/imessage/reader.js";
import { listAdapterPlatforms } from "../adapters/registry.js";
import type { AuthSessionRow, CuedDatabase, IntegrationStateRow } from "../db/database.js";
import {
  type AuthSessionState,
  type ConnectionKind,
  getDefaultAccountKeyForPlatform,
  type IntegrationAuthState,
  type IntegrationLaunchStrategy,
  type IntegrationRuntimeKind,
  isRequestableIntegrationPlatform,
  type Platform,
  parseIntegrationAuthState,
  parseIntegrationRuntimeKind,
  parsePlatform,
  REQUESTABLE_INTEGRATION_PLATFORM_VALUES,
} from "../types/provider.js";
import { resolveMacOSNativeBinary } from "../workers/native-binary.js";

export interface IntegrationStateSummary {
  platform: Platform;
  accountKey: string;
  displayName: string | null;
  authState: IntegrationAuthState;
  enabled: boolean;
  connectionKind: ConnectionKind;
  runtimeKind: IntegrationRuntimeKind;
  syncCapable: boolean;
  launchStrategy: IntegrationLaunchStrategy | null;
  launchTarget: string | null;
  importedFrom: string | null;
  artifactPaths: string[];
  metadata: Record<string, unknown> | null;
  lastSeenAt: number;
  updatedAt: number;
  latestAuthSessionId: string | null;
}

export interface AuthSessionSummary {
  id: string;
  platform: Platform;
  accountKey: string;
  integrationStateId: string;
  state: AuthSessionState;
  nativePid: number | null;
  requestedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  keychainService: string | null;
  keychainAccount: string | null;
  resultSummary: Record<string, unknown> | null;
  errorSummary: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ManagedIntegrationState {
  platform: Platform;
  accountKey: string;
  displayName: string;
  authState: IntegrationAuthState;
  enabled: boolean;
  connectionKind: ConnectionKind;
  runtimeKind: IntegrationRuntimeKind;
  syncCapable: boolean;
  launchStrategy?: IntegrationLaunchStrategy | null;
  launchTarget?: string | null;
  importedFrom: string;
  artifactPaths?: string[];
  metadata?: Record<string, unknown>;
}

interface RequestableIntegrationConfig {
  connectionKind: ConnectionKind;
  runtimeKind: IntegrationRuntimeKind;
  launchStrategy: IntegrationLaunchStrategy;
  launchTarget: string | null;
  displayName: string;
  metadata?: Record<string, unknown>;
}

const REQUESTABLE_INTEGRATIONS: Record<string, RequestableIntegrationConfig> = {
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

function now(): number {
  return Date.now();
}

export function normalizeIntegrationPlatform(platform: string): Platform {
  const normalized = platform.trim().toLowerCase();
  const aliased = normalized === "x" ? "twitter" : normalized;
  const parsed = parsePlatform(aliased);
  if (!parsed) {
    throw new Error(`Unsupported integration platform: ${platform}`);
  }
  return parsed;
}

export function listRequestableIntegrationPlatforms(): Platform[] {
  return [...REQUESTABLE_INTEGRATION_PLATFORM_VALUES];
}

function deriveRuntimeKind(row: Pick<IntegrationStateRow, "metadata_json" | "launch_strategy">): IntegrationRuntimeKind {
  const metadata = row.metadata_json
    ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
    : {};
  const fromMetadata = parseIntegrationRuntimeKind(
    typeof metadata.runtimeKind === "string" ? metadata.runtimeKind : null,
    "native",
  );
  if (typeof metadata.runtimeKind === "string") {
    return fromMetadata;
  }

  if (row.launch_strategy === "chromium-auth") return "chromium";
  if (row.launch_strategy === "qr-native") return "qr_native";
  return "native";
}

export function getChromiumProfileDir(platform: Platform, accountKey: string): string {
  return join(CUED_BROWSER_DIR, platform, accountKey);
}

function getRequestableIntegration(platform: string): RequestableIntegrationConfig {
  const normalized = normalizeIntegrationPlatform(platform);
  if (!isRequestableIntegrationPlatform(normalized)) {
    throw new Error(`Unsupported integration request: ${platform}`);
  }
  return REQUESTABLE_INTEGRATIONS[normalized];
}

function getContactsAuthState(): IntegrationAuthState {
  const nativeBinary = resolveMacOSNativeBinary(process.env.CUED_CONTACTS_NATIVE_BINARY);
  if (!nativeBinary) {
    return "native_helper_missing";
  }

  try {
    const stdout = execFileSync(nativeBinary, ["contacts", "status"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(stdout) as { status?: string };
    return parseIntegrationAuthState(parsed.status);
  } catch {
    return "check_failed";
  }
}

function getIMessageAuthState(): IntegrationAuthState {
  const chatDbPath = process.env.CUED_IMESSAGE_DB_PATH ?? DEFAULT_CHAT_DB_PATH;
  if (!existsSync(chatDbPath)) {
    return "missing";
  }

  try {
    const reader = new IMessageReader(chatDbPath);
    try {
      reader.getMaxMessageRowid();
      return "authorized";
    } finally {
      reader.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("authorization denied") || message.includes("unable to open database file")) {
      return "needs_full_disk_access";
    }
    return "blocked";
  }
}

function buildLocalIntegrationStates(): ManagedIntegrationState[] {
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

function resolveAccountKey(
  db: CuedDatabase,
  platform: Platform,
  accountKey?: string,
): string {
  if (accountKey) {
    return accountKey;
  }

  const matches = db.listIntegrationStates().filter((row) => row.platform === platform);
  if (matches.length === 1) {
    return matches[0]!.account_key;
  }

  throw new Error(
    matches.length === 0
      ? `Integration not found: ${platform}`
      : `Multiple accounts found for ${platform}; specify the account key`,
  );
}

function addSupportedByDaemonMetadata(integration: ManagedIntegrationState): ManagedIntegrationState {
  const supportedPlatforms = new Set<string>(listAdapterPlatforms());
  return {
    ...integration,
    metadata: {
      ...(integration.metadata ?? {}),
      runtimeKind: integration.runtimeKind,
      supportedByDaemon: supportedPlatforms.has(integration.platform),
    },
  };
}

function getKeychainMetadata(metadata: Record<string, unknown> | null): {
  keychainService: string | null;
  keychainAccount: string | null;
} {
  return {
    keychainService: typeof metadata?.keychainService === "string" ? metadata.keychainService : null,
    keychainAccount: typeof metadata?.keychainAccount === "string" ? metadata.keychainAccount : null,
  };
}

function deleteKeychainSecret(keychainService: string | null, keychainAccount: string | null): void {
  if (!keychainService || !keychainAccount) {
    return;
  }

  try {
    execFileSync(
      "security",
      ["delete-generic-password", "-s", keychainService, "-a", keychainAccount],
      { stdio: "ignore" },
    );
  } catch {
    // Best-effort delete; missing entries are fine.
  }
}

export function summarizeAuthSessions(rows: AuthSessionRow[]): AuthSessionSummary[] {
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
      ? (JSON.parse(row.result_summary_json) as Record<string, unknown>)
      : null,
    errorSummary: row.error_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function summarizeIntegrationStates(
  db: CuedDatabase,
  rows: IntegrationStateRow[],
): IntegrationStateSummary[] {
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
    artifactPaths: row.artifact_paths_json ? (JSON.parse(row.artifact_paths_json) as string[]) : [],
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : null,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
    latestAuthSessionId: db.getLatestAuthSession(row.platform, row.account_key)?.id ?? null,
  }));
}

export function listIntegrationStates(db: CuedDatabase): IntegrationStateSummary[] {
  return summarizeIntegrationStates(db, db.listIntegrationStates());
}

export function listAuthSessions(db: CuedDatabase, limit = 20): AuthSessionSummary[] {
  return summarizeAuthSessions(db.listAuthSessions(limit));
}

export function getAuthSessionSummary(db: CuedDatabase, sessionId: string): AuthSessionSummary | null {
  const row = db.getAuthSession(sessionId);
  return row ? summarizeAuthSessions([row])[0]! : null;
}

export function getIntegrationSummary(
  db: CuedDatabase,
  platform: string,
  accountKey?: string,
): IntegrationStateSummary {
  const normalized = normalizeIntegrationPlatform(platform);
  const resolvedAccountKey = resolveAccountKey(db, normalized, accountKey);
  const row = db.getIntegrationState(normalized, resolvedAccountKey);
  if (!row) {
    throw new Error(`Integration not found: ${normalized}/${resolvedAccountKey}`);
  }
  return summarizeIntegrationStates(db, [row])[0]!;
}

export function refreshManagedIntegrationStates(db: CuedDatabase): {
  refreshed: number;
  integrations: IntegrationStateSummary[];
} {
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

export function setIntegrationEnabled(
  db: CuedDatabase,
  platform: string,
  accountKey: string | undefined,
  enabled: boolean,
): IntegrationStateSummary {
  const normalized = normalizeIntegrationPlatform(platform);
  const resolvedAccountKey = resolveAccountKey(db, normalized, accountKey);
  db.setIntegrationEnabled(normalized, resolvedAccountKey, enabled);
  return getIntegrationSummary(db, normalized, resolvedAccountKey);
}

function ensureRequestableIntegrationState(
  db: CuedDatabase,
  platform: string,
  accountKey?: string,
): IntegrationStateSummary {
  const requested = getRequestableIntegration(platform);
  const normalized = normalizeIntegrationPlatform(platform);
  const resolvedAccountKey = accountKey ?? getDefaultAccountKeyForPlatform(normalized);
  const existing = db.getIntegrationState(normalized, resolvedAccountKey);
  const existingMetadata = existing?.metadata_json
    ? (JSON.parse(existing.metadata_json) as Record<string, unknown>)
    : {};
  const browserProfileDir = requested.runtimeKind === "chromium"
    ? getChromiumProfileDir(normalized, resolvedAccountKey)
    : null;

  const supportedByDaemon = new Set<string>(listAdapterPlatforms()).has(normalized);
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

export function requestIntegrationAccess(
  db: CuedDatabase,
  platform: string,
  accountKey?: string,
): {
  integration: IntegrationStateSummary;
  authSession: AuthSessionSummary;
} {
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
    authSession: getAuthSessionSummary(db, sessionId)!,
  };
}

export const connectIntegration = requestIntegrationAccess;

export function markAuthSessionInProgress(
  db: CuedDatabase,
  sessionId: string,
  nativePid: number,
): AuthSessionSummary {
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
      ? (JSON.parse(integration.metadata_json) as Record<string, unknown>)
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
      artifactPaths: integration.artifact_paths_json ? JSON.parse(integration.artifact_paths_json) as string[] : [],
      metadata: {
        ...metadata,
        latestAuthSessionId: sessionId,
      },
    });
  }

  return getAuthSessionSummary(db, sessionId)!;
}

export function completeAuthSession(
  db: CuedDatabase,
  sessionId: string,
  input: {
    state: Extract<AuthSessionState, "authenticated" | "failed" | "cancelled">;
    keychainService?: string | null;
    keychainAccount?: string | null;
    resultSummary?: Record<string, unknown> | null;
    errorSummary?: string | null;
  },
): { authSession: AuthSessionSummary; integration: IntegrationStateSummary } {
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
    ? (JSON.parse(integration.metadata_json) as Record<string, unknown>)
    : {};
  const supportedByDaemon = new Set<string>(listAdapterPlatforms()).has(integration.platform);
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
    artifactPaths: integration.artifact_paths_json ? JSON.parse(integration.artifact_paths_json) as string[] : [],
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
    authSession: getAuthSessionSummary(db, sessionId)!,
    integration: getIntegrationSummary(db, session.platform, session.account_key),
  };
}

export function disconnectIntegration(
  db: CuedDatabase,
  platform: string,
  accountKey?: string,
): IntegrationStateSummary {
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

export function buildIntegrationStatus(db: CuedDatabase): {
  integrations: IntegrationStateSummary[];
  authSessions: AuthSessionSummary[];
} {
  return {
    integrations: listIntegrationStates(db),
    authSessions: listAuthSessions(db, 20),
  };
}

export function getPlatformRuntimeDefaults(platform: Platform): {
  runtimeKind: IntegrationRuntimeKind;
  accountKey: string;
} {
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
