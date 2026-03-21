import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { CUED_BROWSER_DIR } from "../../../core/config.js";
import { resolveHostOS, summarizePlatformCapability } from "../../../core/platform-capabilities.js";
import { safeParseJsonRecord, safeParseJsonStringArray } from "../../../db/codecs.js";
import type { AuthSessionRow, CuedDatabase, IntegrationStateRow } from "../../../db/database.js";
import { inspectSlackHelper } from "../../slack/helper/binary.js";
import { listAdapterPlatforms } from "../registry.js";
import {
  getDefaultAccountKeyForPlatform,
  type IntegrationRuntimeKind,
  isOnboardingVisiblePlatform,
  isRequestableIntegrationPlatform,
  type Platform,
  parseIntegrationRuntimeKind,
  parsePlatform,
  REQUESTABLE_INTEGRATION_PLATFORM_VALUES,
} from "../types.js";
import { buildLocalIntegrationStates } from "./local.js";
import type {
  AuthSessionSummary,
  IntegrationRowLike,
  IntegrationStateSummary,
  ManagedIntegrationState,
  RequestableIntegrationConfig,
} from "./types.js";

export { getContactsAuthState, getIMessageAuthState } from "./local.js";

export const REQUESTABLE_INTEGRATIONS: Record<string, RequestableIntegrationConfig> = {
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

export function now(): number {
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

export function deriveRuntimeKind(row: IntegrationRowLike): IntegrationRuntimeKind {
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

export function shouldAppendAccountKeyToDisplayName(
  platform: Platform,
  accountKey: string,
): boolean {
  if (platform === "slack" && isGeneratedPendingSlackAccountKey(accountKey)) {
    return false;
  }
  return accountKey !== getDefaultAccountKeyForPlatform(platform);
}

export function getRequestableIntegration(platform: string): RequestableIntegrationConfig {
  const normalized = normalizeIntegrationPlatform(platform);
  if (!isRequestableIntegrationPlatform(normalized)) {
    throw new Error(`Unsupported integration request: ${platform}`);
  }
  return REQUESTABLE_INTEGRATIONS[normalized];
}

export function resolveAccountKey(
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

export function addSupportedByDaemonMetadata(
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

export function normalizePersistedRequestableIntegrationRow(row: IntegrationStateRow): {
  syncCapable: boolean;
  metadata: Record<string, unknown> | null;
} | null {
  if (!isRequestableIntegrationPlatform(row.platform)) {
    return null;
  }
  const supportedByDaemon = new Set<string>(listAdapterPlatforms()).has(row.platform);
  const metadata = safeParseJsonRecord(row.metadata_json, "integration_states.metadata_json");
  const slackHelperInspection = row.platform === "slack" ? inspectSlackHelper() : null;
  const slackHelperReady =
    row.platform !== "slack" ||
    (Boolean(slackHelperInspection?.helperPath) &&
      slackHelperInspection?.versionSupported === true);
  return {
    syncCapable: row.auth_state === "authenticated" && supportedByDaemon && slackHelperReady,
    metadata: {
      ...(metadata ?? {}),
      supportedByDaemon,
      ...(row.platform === "slack"
        ? {
            authManagedBy:
              typeof metadata?.authManagedBy === "string"
                ? metadata.authManagedBy
                : "chromium-runtime",
            syncTransport: "slack-helper",
            slackHelperPath: slackHelperInspection?.helperPath ?? null,
            slackHelperVersion: slackHelperInspection?.version ?? null,
            slackHelperProtocolVersion: slackHelperInspection?.protocolVersion ?? null,
            slackHelperVersionSupported: slackHelperInspection?.versionSupported ?? false,
          }
        : {}),
    },
  };
}

export function refreshPersistedRequestableIntegrationStates(db: CuedDatabase): number {
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
    if (
      row.sync_capable === nextSyncCapable &&
      JSON.stringify(currentMetadata ?? {}) === JSON.stringify(normalized.metadata ?? {})
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

export function getKeychainMetadata(metadata: Record<string, unknown> | null): {
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

export function deleteKeychainSecret(
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
      { platform: row.platform, authState: row.auth_state },
      hostOs,
    ),
  }));
}

export function summarizeManagedIntegrationState(
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
      { platform: integration.platform, authState: integration.authState },
      hostOs,
    ),
  };
}

export function upsertManagedIntegrationState(
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

function buildBootstrappedLocalIntegration(
  db: CuedDatabase,
  platform: Extract<Platform, "contacts" | "imessage">,
): IntegrationStateSummary {
  return summarizeManagedIntegrationState(
    db,
    addSupportedByDaemonMetadata({
      platform,
      accountKey: "local",
      displayName: platform === "contacts" ? "Contacts.app" : "Messages",
      authState: "unknown",
      enabled: true,
      connectionKind: "native",
      runtimeKind: "native",
      syncCapable: false,
      launchStrategy: "system-settings",
      launchTarget:
        platform === "contacts"
          ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts"
          : "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
      importedFrom: "bootstrap",
    }),
  );
}

function buildSetupIntegrations(
  db: CuedDatabase,
  options: { includeLiveLocalIntegrations?: boolean } = {},
): IntegrationStateSummary[] {
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

  if (options.includeLiveLocalIntegrations ?? true) {
    for (const managed of buildLocalIntegrationStates()) {
      if (!byPlatform.has(managed.platform)) {
        byPlatform.set(
          managed.platform,
          summarizeManagedIntegrationState(db, addSupportedByDaemonMetadata(managed)),
        );
      }
    }
  } else {
    for (const platform of ["contacts", "imessage"] as const) {
      if (!byPlatform.has(platform)) {
        byPlatform.set(platform, buildBootstrappedLocalIntegration(db, platform));
      }
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

export function firstNonEmptyDisplayName(
  ...values: Array<string | null | undefined>
): string | null {
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

export function resolveCompletedDisplayName(
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

export function resolveCompletedMetadata(
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

export function buildIntegrationStatus(
  db: CuedDatabase,
  options: { includeLiveLocalIntegrations?: boolean } = {},
): {
  hostOs: ReturnType<typeof resolveHostOS>;
  integrations: IntegrationStateSummary[];
  setupIntegrations: IntegrationStateSummary[];
} {
  return {
    hostOs: resolveHostOS(),
    integrations: listIntegrationStates(db),
    setupIntegrations: buildSetupIntegrations(db, options),
  };
}
