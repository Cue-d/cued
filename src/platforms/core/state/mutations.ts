import { rmSync } from "node:fs";
import {
  safeParseJsonRecord,
  safeParseJsonStringArray,
} from "../../../db/codecs.js";
import type { AuthSessionRow, CuedDatabase } from "../../../db/database.js";
import { getSignalConfigDir } from "../../signal/cli/binary.js";
import { getWhatsAppStoreDir } from "../../whatsapp/helper/binary.js";
import {
  type AuthSessionState,
  getDefaultAccountKeyForPlatform,
  type Platform,
} from "../types.js";
import type {
  AuthSessionSummary,
  CompletedAuthSessionInput,
  CompletedAuthSessionSummary,
  IntegrationStateSummary,
} from "./types.js";
import {
  deleteKeychainSecret,
  firstNonEmptyDisplayName,
  getAuthSessionSummary,
  getChromiumProfileDir,
  getIntegrationSummary,
  getKeychainMetadata,
  getRequestableIntegration,
  now,
  normalizeIntegrationPlatform,
  resolveAccountKey,
  resolveCompletedDisplayName,
  resolveCompletedMetadata,
  shouldAppendAccountKeyToDisplayName,
} from "./status.js";
import { listAdapterPlatforms } from "../registry.js";

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

function cancelStaleAuthSessions(db: CuedDatabase, platform: Platform, accountKey: string): void {
  for (const session of db.listAuthSessions(100)) {
    if (session.platform !== platform || session.account_key !== accountKey) {
      continue;
    }
    if (session.state !== "requested" && session.state !== "in_progress") {
      continue;
    }
    db.updateAuthSessionState({
      id: session.id,
      state: "cancelled",
      finishedAt: now(),
      errorSummary: "Superseded by a newer auth session request",
    });
  }
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
  cancelStaleAuthSessions(db, integration.platform, integration.accountKey);
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

function resolveCompletedAccountKey(
  session: AuthSessionRow,
  input: CompletedAuthSessionInput,
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

export function completeAuthSession(
  db: CuedDatabase,
  sessionId: string,
  input: CompletedAuthSessionInput,
): CompletedAuthSessionSummary {
  const session = db.getAuthSession(sessionId);
  if (!session) {
    return { authSession: null, integration: null };
  }
  const existingIntegration = db.getIntegrationState(session.platform, session.account_key);
  if (!existingIntegration && session.state === "cancelled") {
    return { authSession: null, integration: null };
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
  const targetDisplayName = resolveCompletedDisplayName(integration.display_name, input.resultSummary);
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
