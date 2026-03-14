import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_CHAT_DB_PATH, IMessageReader } from "../adapters/imessage/reader.js";
import { listAdapterPlatforms } from "../adapters/registry.js";
import { CUED_BROWSER_DIR } from "../config.js";
import { safeParseJsonRecord, safeParseJsonStringArray } from "../db/codecs.js";
import type { AuthSessionRow, CuedDatabase, IntegrationStateRow } from "../db/database.js";
import {
  type PlatformCapabilitySummary,
  resolveHostOS,
  summarizePlatformCapability,
} from "../platform-capabilities.js";
import {
  type AuthSessionState,
  type ConnectionKind,
  getDefaultAccountKeyForPlatform,
  type IntegrationAuthState,
  type IntegrationLaunchStrategy,
  type IntegrationRuntimeKind,
  isOnboardingVisiblePlatform,
  isRequestableIntegrationPlatform,
  type Platform,
  parseIntegrationAuthState,
  parseIntegrationRuntimeKind,
  parsePlatform,
  REQUESTABLE_INTEGRATION_PLATFORM_VALUES,
} from "../types/provider.js";
import { resolveMacOSNativeBinary } from "../workers/native-binary.js";
import {
  getSignalConfigDir,
  inspectSignalCli,
  isSignalCliVersionSupported,
  readSignalLinkedAccount,
} from "./signal-cli.js";
import { importSlackDesktopAuth } from "./slack-desktop-auth.js";
import {
  getWhatsAppStoreDir,
  inspectWhatsAppHelper,
  readWhatsAppHelperStatus,
} from "./whatsapp-helper.js";

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
  capability: PlatformCapabilitySummary;
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

export interface CompletedAuthSessionSummary {
  authSession: AuthSessionSummary | null;
  integration: IntegrationStateSummary | null;
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
    connectionKind: "local-cli",
    runtimeKind: "qr_native",
    launchStrategy: "qr-native",
    launchTarget: null,
    displayName: "Signal",
    metadata: {
      authCapture: "signal_cli_link",
      pairingKind: "native_qr",
      helper: "cued-signal-cli",
    },
  },
};

const SLACK_PENDING_ACCOUNT_KEY_PREFIX = "pending-slack-";

function now(): number {
  return Date.now();
}

export function normalizeIntegrationPlatform(platform: string): Platform {
  const normalized = platform.trim().toLowerCase();
  const parsed = parsePlatform(normalized);
  if (!parsed) {
    throw new Error(`Unsupported integration platform: ${platform}`);
  }
  return parsed;
}

export function listRequestableIntegrationPlatforms(): Platform[] {
  return [...REQUESTABLE_INTEGRATION_PLATFORM_VALUES];
}

function deriveRuntimeKind(
  row: Pick<IntegrationStateRow, "metadata_json" | "launch_strategy">,
): IntegrationRuntimeKind {
  const metadata = safeParseJsonRecord(row.metadata_json, "integration_states.metadata_json") ?? {};
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

function isGeneratedPendingSlackAccountKey(accountKey: string): boolean {
  return accountKey.startsWith(SLACK_PENDING_ACCOUNT_KEY_PREFIX);
}

function shouldAppendAccountKeyToDisplayName(platform: Platform, accountKey: string): boolean {
  if (platform === "slack" && isGeneratedPendingSlackAccountKey(accountKey)) {
    return false;
  }
  return accountKey !== getDefaultAccountKeyForPlatform(platform);
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

  const nativeBinary = resolveMacOSNativeBinary(process.env.CUED_IMESSAGE_NATIVE_BINARY);
  if (nativeBinary) {
    try {
      execFileSync(
        nativeBinary,
        ["imessage", "dump", "--db-path", chatDbPath, "--after-rowid", "0", "--limit", "1"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      return "authorized";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("authorization denied") ||
        message.includes("unable to open database file")
      ) {
        return "needs_full_disk_access";
      }
      return "blocked";
    }
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
    if (
      message.includes("authorization denied") ||
      message.includes("unable to open database file")
    ) {
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

async function buildSignalManagedState(
  existing: IntegrationStateRow | null,
): Promise<ManagedIntegrationState | null> {
  const accountKey = existing?.account_key ?? "default";
  const configDir = getSignalConfigDir(accountKey);
  const inspected = await inspectSignalCli();
  const linkedAccount = readSignalLinkedAccount(configDir);
  const supportedByDaemon = new Set<string>(listAdapterPlatforms()).has("signal");

  let authState: IntegrationAuthState;
  if (!inspected.cliPath) {
    authState = existing?.auth_state === "cancelled" ? "cancelled" : "missing";
  } else if (!isSignalCliVersionSupported(inspected.version)) {
    authState = existing?.auth_state === "cancelled" ? "cancelled" : "outdated";
  } else if (linkedAccount) {
    authState = "authenticated";
  } else if (existing?.auth_state === "requested" || existing?.auth_state === "in_progress") {
    authState = existing.auth_state;
  } else if (existing?.auth_state === "cancelled") {
    authState = "cancelled";
  } else {
    authState = "blocked";
  }

  return {
    platform: "signal",
    accountKey,
    displayName:
      firstNonEmptyDisplayName(linkedAccount, existing?.display_name, "Signal") ?? "Signal",
    authState,
    enabled: existing ? existing.enabled === 1 : true,
    connectionKind: "local-cli",
    runtimeKind: "qr_native",
    syncCapable: authState === "authenticated" && supportedByDaemon,
    launchStrategy: "qr-native",
    launchTarget: null,
    importedFrom: existing?.imported_from ?? "bundled-helper",
    artifactPaths: [configDir],
    metadata: {
      authCapture: "signal_cli_link",
      pairingKind: "native_qr",
      helper: "cued-signal-cli",
      authManagedBy: "signal-helper-runtime",
      runtimeKind: "qr_native",
      configDir,
      signalCliPath: inspected.cliPath,
      signalHelperRoot: inspected.helperRoot,
      signalJavaHome: inspected.javaHome,
      signalCliVersion: inspected.version?.raw ?? null,
      signalLinkedAccount: linkedAccount,
      signalVersionSupported: isSignalCliVersionSupported(inspected.version),
      lastVerifiedAt: now(),
    },
  };
}

async function buildWhatsAppManagedState(
  existing: IntegrationStateRow | null,
): Promise<ManagedIntegrationState | null> {
  const accountKey = existing?.account_key ?? "default";
  const storeDir = getWhatsAppStoreDir(accountKey);
  const inspected = inspectWhatsAppHelper();
  const supportedByDaemon = new Set<string>(listAdapterPlatforms()).has("whatsapp");

  let authState: IntegrationAuthState;
  let accountJid: string | null = null;
  let pushName: string | null = null;
  let helperVersion = inspected.version;

  if (!inspected.helperPath) {
    authState = existing?.auth_state === "cancelled" ? "cancelled" : "missing";
  } else {
    try {
      const status = await readWhatsAppHelperStatus(storeDir);
      accountJid = status.accountJid;
      pushName = status.pushName;
      helperVersion = status.helperVersion ?? helperVersion;
      if (status.authenticated) {
        authState = "authenticated";
      } else if (existing?.auth_state === "requested" || existing?.auth_state === "in_progress") {
        authState = existing.auth_state;
      } else if (existing?.auth_state === "cancelled") {
        authState = "cancelled";
      } else {
        authState = "blocked";
      }
    } catch {
      authState = existing?.auth_state === "cancelled" ? "cancelled" : "blocked";
    }
  }

  return {
    platform: "whatsapp",
    accountKey,
    displayName:
      firstNonEmptyDisplayName(pushName, accountJid, existing?.display_name, "WhatsApp") ??
      "WhatsApp",
    authState,
    enabled: existing ? existing.enabled === 1 : true,
    connectionKind: "qr-link",
    runtimeKind: "qr_native",
    syncCapable: authState === "authenticated" && supportedByDaemon,
    launchStrategy: "qr-native",
    launchTarget: null,
    importedFrom: existing?.imported_from ?? "bundled-helper",
    artifactPaths: [storeDir],
    metadata: {
      authCapture: "qr_pairing",
      pairingKind: "native_qr",
      helper: "cued-whatsapp-helper",
      authManagedBy: "whatsapp-helper-runtime",
      runtimeKind: "qr_native",
      storeDir,
      whatsappHelperPath: inspected.helperPath,
      whatsappHelperVersion: helperVersion,
      whatsappAccountJid: accountJid,
      whatsappPushName: pushName,
      lastVerifiedAt: now(),
    },
  };
}

function resolveAccountKey(db: CuedDatabase, platform: Platform, accountKey?: string): string {
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

function addSupportedByDaemonMetadata(
  integration: ManagedIntegrationState,
): ManagedIntegrationState {
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

function normalizePersistedRequestableIntegrationRow(row: IntegrationStateRow): {
  syncCapable: boolean;
  metadata: Record<string, unknown> | null;
} | null {
  if (!isRequestableIntegrationPlatform(row.platform)) {
    return null;
  }

  const supportedByDaemon = new Set<string>(listAdapterPlatforms()).has(row.platform);
  const metadata = safeParseJsonRecord(row.metadata_json, "integration_states.metadata_json");
  return {
    syncCapable: row.auth_state === "authenticated" && supportedByDaemon,
    metadata: {
      ...(metadata ?? {}),
      supportedByDaemon,
    },
  };
}

function refreshPersistedRequestableIntegrationStates(db: CuedDatabase): number {
  let refreshed = 0;

  for (const row of db.listIntegrationStates()) {
    const normalized = normalizePersistedRequestableIntegrationRow(row);
    if (!normalized) {
      continue;
    }

    const nextSyncCapable = normalized.syncCapable ? 1 : 0;
    const currentMetadata = safeParseJsonRecord(
      row.metadata_json,
      "integration_states.metadata_json",
    );
    const currentSupportedByDaemon = currentMetadata?.supportedByDaemon;
    if (
      row.sync_capable === nextSyncCapable &&
      currentSupportedByDaemon === normalized.metadata?.supportedByDaemon
    ) {
      continue;
    }

    db.upsertIntegrationState({
      platform: row.platform,
      accountKey: row.account_key,
      displayName: row.display_name,
      authState: row.auth_state,
      enabled: row.enabled === 1,
      connectionKind: row.connection_kind,
      syncCapable: normalized.syncCapable,
      launchStrategy: row.launch_strategy,
      launchTarget: row.launch_target,
      importedFrom: row.imported_from,
      artifactPaths: safeParseJsonStringArray(
        row.artifact_paths_json,
        "integration_states.artifact_paths_json",
      ),
      metadata: normalized.metadata,
    });
    refreshed += 1;
  }

  return refreshed;
}

function getKeychainMetadata(metadata: Record<string, unknown> | null): {
  keychainService: string | null;
  keychainAccount: string | null;
} {
  return {
    keychainService:
      typeof metadata?.keychainService === "string" ? metadata.keychainService : null,
    keychainAccount:
      typeof metadata?.keychainAccount === "string" ? metadata.keychainAccount : null,
  };
}

function deleteKeychainSecret(
  keychainService: string | null,
  keychainAccount: string | null,
): void {
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
    resultSummary: safeParseJsonRecord(
      row.result_summary_json,
      "auth_sessions.result_summary_json",
    ),
    errorSummary: row.error_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function summarizeIntegrationStates(
  db: CuedDatabase,
  rows: IntegrationStateRow[],
): IntegrationStateSummary[] {
  const hostOs = resolveHostOS();
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
    artifactPaths: safeParseJsonStringArray(
      row.artifact_paths_json,
      "integration_states.artifact_paths_json",
    ),
    metadata: safeParseJsonRecord(row.metadata_json, "integration_states.metadata_json"),
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
    latestAuthSessionId: db.getLatestAuthSession(row.platform, row.account_key)?.id ?? null,
    capability: summarizePlatformCapability(
      row.platform,
      {
        platform: row.platform,
        authState: row.auth_state,
      },
      hostOs,
    ),
  }));
}

function summarizeManagedIntegrationState(
  db: CuedDatabase,
  integration: ManagedIntegrationState,
): IntegrationStateSummary {
  const hostOs = resolveHostOS();
  return {
    platform: integration.platform,
    accountKey: integration.accountKey,
    displayName: integration.displayName,
    authState: integration.authState,
    enabled: integration.enabled,
    connectionKind: integration.connectionKind,
    runtimeKind: integration.runtimeKind,
    syncCapable: integration.syncCapable,
    launchStrategy: integration.launchStrategy ?? null,
    launchTarget: integration.launchTarget ?? null,
    importedFrom: integration.importedFrom,
    artifactPaths: integration.artifactPaths ?? [],
    metadata: integration.metadata ?? null,
    lastSeenAt: now(),
    updatedAt: now(),
    latestAuthSessionId:
      db.getLatestAuthSession(integration.platform, integration.accountKey)?.id ?? null,
    capability: summarizePlatformCapability(
      integration.platform,
      {
        platform: integration.platform,
        authState: integration.authState,
      },
      hostOs,
    ),
  };
}

function upsertManagedIntegrationState(
  db: CuedDatabase,
  integration: ManagedIntegrationState,
): void {
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

function buildSetupIntegrations(db: CuedDatabase): IntegrationStateSummary[] {
  const onboardingOrder: Platform[] = [
    "contacts",
    "imessage",
    "slack",
    "linkedin",
    "whatsapp",
    "signal",
  ];
  const byPlatform = new Map<Platform, IntegrationStateSummary>();

  for (const integration of listIntegrationStates(db)) {
    if (!isOnboardingVisiblePlatform(integration.platform)) {
      continue;
    }
    if (!byPlatform.has(integration.platform)) {
      byPlatform.set(integration.platform, integration);
    }
  }

  for (const managed of buildLocalIntegrationStates()) {
    if (!byPlatform.has(managed.platform)) {
      byPlatform.set(
        managed.platform,
        summarizeManagedIntegrationState(db, addSupportedByDaemonMetadata(managed)),
      );
    }
  }

  for (const platform of REQUESTABLE_INTEGRATION_PLATFORM_VALUES) {
    if (byPlatform.has(platform)) {
      continue;
    }
    const requested = getRequestableIntegration(platform);
    byPlatform.set(
      platform,
      summarizeManagedIntegrationState(
        db,
        addSupportedByDaemonMetadata({
          platform,
          accountKey: getDefaultAccountKeyForPlatform(platform),
          displayName: requested.displayName,
          authState: "missing",
          enabled: true,
          connectionKind: requested.connectionKind,
          runtimeKind: requested.runtimeKind,
          syncCapable: false,
          launchStrategy: requested.launchStrategy,
          launchTarget: requested.launchTarget,
          importedFrom: "bootstrap",
          metadata: requested.metadata,
        }),
      ),
    );
  }

  return onboardingOrder
    .filter(isOnboardingVisiblePlatform)
    .map((platform) => byPlatform.get(platform))
    .filter((value): value is IntegrationStateSummary => Boolean(value));
}

export function listIntegrationStates(db: CuedDatabase): IntegrationStateSummary[] {
  return summarizeIntegrationStates(db, db.listIntegrationStates());
}

export function listAuthSessions(db: CuedDatabase, limit = 20): AuthSessionSummary[] {
  return summarizeAuthSessions(db.listAuthSessions(limit));
}

export function getAuthSessionSummary(
  db: CuedDatabase,
  sessionId: string,
): AuthSessionSummary | null {
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

export async function refreshManagedIntegrationStates(db: CuedDatabase): Promise<{
  refreshed: number;
  integrations: IntegrationStateSummary[];
}> {
  const refreshedPersistedRequestables = refreshPersistedRequestableIntegrationStates(db);
  const managed = buildLocalIntegrationStates().map(addSupportedByDaemonMetadata);

  for (const integration of managed) {
    upsertManagedIntegrationState(db, integration);
  }

  const importedDesktop = await importSlackDesktopAuth(db);
  const existingStates = db.listIntegrationStates();
  const signalRows = existingStates.filter((row) => row.platform === "signal");
  const signalInputs = signalRows.length > 0 ? signalRows : [null];
  const signalManagedStates = (
    await Promise.all(signalInputs.map((row) => buildSignalManagedState(row)))
  ).filter((state): state is ManagedIntegrationState => Boolean(state));
  for (const integration of signalManagedStates) {
    upsertManagedIntegrationState(db, integration);
  }

  const whatsAppRows = existingStates.filter((row) => row.platform === "whatsapp");
  const whatsAppInputs = whatsAppRows.length > 0 ? whatsAppRows : [null];
  const whatsAppManagedStates = (
    await Promise.all(whatsAppInputs.map((row) => buildWhatsAppManagedState(row)))
  ).filter((state): state is ManagedIntegrationState => Boolean(state));
  for (const integration of whatsAppManagedStates) {
    upsertManagedIntegrationState(db, integration);
  }

  return {
    refreshed:
      refreshedPersistedRequestables +
      managed.length +
      importedDesktop.filter((entry) => entry.imported).length +
      signalManagedStates.length +
      whatsAppManagedStates.length,
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
    ? safeParseJsonRecord(existing.metadata_json, "integration_states.metadata_json")
    : {};
  const normalizedExistingMetadata = existingMetadata ?? {};
  const browserProfileDir =
    requested.runtimeKind === "chromium"
      ? getChromiumProfileDir(normalized, resolvedAccountKey)
      : null;
  const signalConfigDir = normalized === "signal" ? getSignalConfigDir(resolvedAccountKey) : null;
  const whatsappStoreDir =
    normalized === "whatsapp" ? getWhatsAppStoreDir(resolvedAccountKey) : null;

  const supportedByDaemon = new Set<string>(listAdapterPlatforms()).has(normalized);
  db.upsertIntegrationState({
    platform: normalized,
    accountKey: resolvedAccountKey,
    displayName:
      accountKey && shouldAppendAccountKeyToDisplayName(normalized, accountKey)
        ? `${requested.displayName} ${accountKey}`
        : requested.displayName,
    authState: existing?.auth_state ?? "requested",
    enabled: existing ? existing.enabled === 1 : true,
    connectionKind: requested.connectionKind,
    syncCapable: false,
    launchStrategy: requested.launchStrategy,
    launchTarget: requested.launchTarget,
    importedFrom:
      existing?.imported_from ?? (normalized === "signal" ? "bundled-helper" : "local-cli"),
    metadata: {
      ...normalizedExistingMetadata,
      ...(requested.metadata ?? {}),
      supportedByDaemon,
      authManagedBy:
        normalized === "signal"
          ? "signal-helper-runtime"
          : requested.runtimeKind === "chromium"
            ? "chromium-runtime"
            : "native-qr-runtime",
      requestedAt: normalizedExistingMetadata.requestedAt ?? now(),
      runtimeKind: requested.runtimeKind,
      browserProfileDir,
      configDir: signalConfigDir,
      storeDir: whatsappStoreDir,
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
    const metadata =
      safeParseJsonRecord(integration.metadata_json, "integration_states.metadata_json") ?? {};
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
      artifactPaths: safeParseJsonStringArray(
        integration.artifact_paths_json,
        "integration_states.artifact_paths_json",
      ),
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
): CompletedAuthSessionSummary {
  const session = db.getAuthSession(sessionId);
  if (!session) {
    return {
      authSession: null,
      integration: null,
    };
  }

  const existingIntegration = db.getIntegrationState(session.platform, session.account_key);
  if (!existingIntegration && session.state === "cancelled") {
    return {
      authSession: null,
      integration: null,
    };
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

  const metadata =
    safeParseJsonRecord(integration.metadata_json, "integration_states.metadata_json") ?? {};
  const targetAccountKey = resolveCompletedAccountKey(session, input);
  const targetDisplayName = resolveCompletedDisplayName(
    integration.display_name,
    input.resultSummary,
  );
  const targetMetadata = resolveCompletedMetadata(
    integration.platform,
    integration.account_key,
    targetAccountKey,
    metadata,
  );
  const existingTarget =
    targetAccountKey === integration.account_key
      ? integration
      : db.getIntegrationState(integration.platform, targetAccountKey);
  const supportedByDaemon = new Set<string>(listAdapterPlatforms()).has(integration.platform);
  const syncCapable =
    input.state === "authenticated"
      ? supportedByDaemon
      : (existingTarget?.sync_capable ?? integration.sync_capable) === 1;
  const artifactPaths = Array.from(
    new Set([
      ...safeParseJsonStringArray(
        existingTarget?.artifact_paths_json ?? null,
        "integration_states.artifact_paths_json",
      ),
      ...safeParseJsonStringArray(
        integration.artifact_paths_json,
        "integration_states.artifact_paths_json",
      ),
    ]),
  );
  db.upsertIntegrationState({
    platform: integration.platform,
    accountKey: targetAccountKey,
    displayName: targetDisplayName,
    authState: input.state,
    enabled: (existingTarget?.enabled ?? integration.enabled) === 1,
    connectionKind: integration.connection_kind,
    syncCapable,
    launchStrategy: integration.launch_strategy,
    launchTarget: integration.launch_target,
    importedFrom: integration.imported_from,
    artifactPaths,
    metadata: {
      ...(safeParseJsonRecord(
        existingTarget?.metadata_json ?? null,
        "integration_states.metadata_json",
      ) ?? {}),
      ...metadata,
      ...targetMetadata,
      latestAuthSessionId: sessionId,
      keychainService: input.keychainService ?? null,
      keychainAccount: resolveCompletedKeychainAccount(targetAccountKey, input.keychainAccount),
      authenticatedAt: input.state === "authenticated" ? now() : null,
      authResult: input.resultSummary ?? null,
      lastAuthError: input.errorSummary ?? null,
    },
  });

  if (targetAccountKey !== integration.account_key) {
    db.updateAuthSessionIdentity({
      id: sessionId,
      accountKey: targetAccountKey,
      integrationStateId: `${integration.platform}:${targetAccountKey}`,
    });
    db.deleteIntegrationState(integration.platform, integration.account_key);
  }

  return {
    authSession: getAuthSessionSummary(db, sessionId)!,
    integration: getIntegrationSummary(db, session.platform, targetAccountKey),
  };
}

function resolveCompletedAccountKey(
  session: AuthSessionRow,
  input: {
    state: Extract<AuthSessionState, "authenticated" | "failed" | "cancelled">;
    keychainAccount?: string | null;
    resultSummary?: Record<string, unknown> | null;
  },
): string {
  if (session.platform !== "slack" || input.state !== "authenticated") {
    return session.account_key;
  }

  const teamId =
    typeof input.resultSummary?.teamId === "string" ? input.resultSummary.teamId.trim() : "";
  if (teamId.length > 0) {
    return teamId;
  }

  const keychainAccount =
    typeof input.keychainAccount === "string" ? input.keychainAccount.trim() : "";
  return keychainAccount.length > 0 ? keychainAccount : session.account_key;
}

function resolveCompletedKeychainAccount(
  accountKey: string,
  keychainAccount?: string | null,
): string | null {
  if (typeof keychainAccount === "string" && keychainAccount.trim().length > 0) {
    return keychainAccount;
  }
  return accountKey;
}

function resolveCompletedDisplayName(
  currentDisplayName: string | null,
  resultSummary?: Record<string, unknown> | null,
): string | null {
  return (
    firstNonEmptyDisplayName(
      typeof resultSummary?.teamName === "string" ? resultSummary.teamName : null,
      typeof resultSummary?.pushName === "string" ? resultSummary.pushName : null,
      typeof resultSummary?.linkedAccount === "string" ? resultSummary.linkedAccount : null,
      typeof resultSummary?.accountJid === "string" ? resultSummary.accountJid : null,
      typeof resultSummary?.profileName === "string" ? resultSummary.profileName : null,
      typeof resultSummary?.displayName === "string" ? resultSummary.displayName : null,
    ) ?? currentDisplayName
  );
}

function firstNonEmptyDisplayName(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function resolveCompletedMetadata(
  platform: Platform,
  fromAccountKey: string,
  toAccountKey: string,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  if (platform !== "slack" || fromAccountKey === toAccountKey) {
    return metadata;
  }

  const currentProfileDir =
    typeof metadata.browserProfileDir === "string" ? metadata.browserProfileDir : null;
  const targetProfileDir = getChromiumProfileDir(platform, toAccountKey);
  if (currentProfileDir && currentProfileDir !== targetProfileDir) {
    try {
      if (existsSync(currentProfileDir)) {
        mkdirSync(dirname(targetProfileDir), { recursive: true });
        if (!existsSync(targetProfileDir)) {
          renameSync(currentProfileDir, targetProfileDir);
        } else {
          rmSync(currentProfileDir, { recursive: true, force: true });
        }
      }
    } catch {
      // Best-effort move. If the rename fails, still point future auth to the target path.
    }
  }

  return {
    ...metadata,
    browserProfileDir: targetProfileDir,
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

  if (integration.platform === "whatsapp") {
    const storeDir =
      typeof integration.metadata?.storeDir === "string"
        ? integration.metadata.storeDir
        : getWhatsAppStoreDir(integration.accountKey);
    rmSync(storeDir, { recursive: true, force: true });
  }

  return getIntegrationSummary(db, integration.platform, integration.accountKey);
}

export function removeIntegration(
  db: CuedDatabase,
  platform: string,
  accountKey?: string,
): { platform: Platform; accountKey: string; removed: true } {
  const integration = getIntegrationSummary(db, platform, accountKey);
  const latestAuthSession = db.getLatestAuthSession(integration.platform, integration.accountKey);
  if (latestAuthSession?.state === "requested" || latestAuthSession?.state === "in_progress") {
    db.updateAuthSessionState({
      id: latestAuthSession.id,
      state: "cancelled",
      nativePid: null,
      finishedAt: now(),
      errorSummary: null,
    });
  }

  const keychain = getKeychainMetadata(integration.metadata);
  deleteKeychainSecret(keychain.keychainService, keychain.keychainAccount);

  const browserProfileDir =
    typeof integration.metadata?.browserProfileDir === "string"
      ? integration.metadata.browserProfileDir
      : null;
  if (browserProfileDir) {
    rmSync(browserProfileDir, { recursive: true, force: true });
  }

  if (integration.platform === "whatsapp") {
    const storeDir =
      typeof integration.metadata?.storeDir === "string"
        ? integration.metadata.storeDir
        : getWhatsAppStoreDir(integration.accountKey);
    rmSync(storeDir, { recursive: true, force: true });
  }

  if (integration.platform === "signal") {
    const configDir =
      typeof integration.metadata?.configDir === "string"
        ? integration.metadata.configDir
        : getSignalConfigDir(integration.accountKey);
    rmSync(configDir, { recursive: true, force: true });
  }

  db.deleteIntegrationState(integration.platform, integration.accountKey);
  return {
    platform: integration.platform,
    accountKey: integration.accountKey,
    removed: true,
  };
}

export function buildIntegrationStatus(db: CuedDatabase): {
  hostOs: ReturnType<typeof resolveHostOS>;
  integrations: IntegrationStateSummary[];
  setupIntegrations: IntegrationStateSummary[];
} {
  return {
    hostOs: resolveHostOS(),
    integrations: listIntegrationStates(db),
    setupIntegrations: buildSetupIntegrations(db),
  };
}

export function getPlatformRuntimeDefaults(platform: Platform): {
  runtimeKind: IntegrationRuntimeKind;
  accountKey: string;
} {
  const runtimeKind =
    platform === "contacts" || platform === "imessage"
      ? "native"
      : platform === "signal" || platform === "whatsapp"
        ? "qr_native"
        : "chromium";
  return {
    runtimeKind,
    accountKey: getDefaultAccountKeyForPlatform(platform),
  };
}
