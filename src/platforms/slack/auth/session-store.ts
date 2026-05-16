import type { CuedDatabase } from "../../../db/database.js";
import { validateIntegrationAccountKey } from "../../core/account-keys.js";
import { getChromiumProfileDir } from "../../core/runtime-paths.js";
import {
  authKeychainService,
  loadKeychainSecret,
  storeKeychainSecret,
} from "../../core/secrets/keychain.js";
import { completeAuthSession } from "../../core/state/mutations.js";
import { isUserRemovedIntegrationMetadata } from "../../core/state/status.js";

const SLACK_KEYCHAIN_SERVICE = authKeychainService("slack");

export interface StoredSlackSessionPayload {
  accountKey: string;
  teamId: string;
  teamName: string;
  userId: string;
  token: string;
  cookie: string;
  savedAt: number;
  sourcePath: string;
  importMethod: string;
}

export interface StoredSlackSessionResult {
  platform: "slack";
  accountKey: string;
  sourcePath: string;
  imported: boolean;
}

export interface StoreSlackSessionOptions {
  reviveUserRemoved?: boolean;
}

function storeSecretInKeychain(
  service: string,
  account: string,
  secret: Record<string, unknown>,
): void {
  storeKeychainSecret(service, account, secret);
}

function keychainSecretExists(service: string, account: string): boolean {
  return loadKeychainSecret(service, account) !== null;
}

export function storeSlackSession(
  db: CuedDatabase,
  payload: StoredSlackSessionPayload,
  options: StoreSlackSessionOptions = {},
): StoredSlackSessionResult {
  const accountKey = validateIntegrationAccountKey(payload.accountKey);
  const existing = db.getIntegrationState("slack", accountKey);
  const existingMetadata = existing?.metadata_json
    ? (JSON.parse(existing.metadata_json) as Record<string, unknown>)
    : {};
  const userRemoved = isUserRemovedIntegrationMetadata(existingMetadata);
  if (userRemoved && !options.reviveUserRemoved) {
    return {
      platform: "slack",
      accountKey,
      sourcePath: payload.sourcePath,
      imported: false,
    };
  }

  const importedSavedAt =
    typeof existingMetadata.importedSavedAt === "number" ? existingMetadata.importedSavedAt : null;
  const alreadyImported =
    existing?.auth_state === "authenticated" &&
    importedSavedAt !== null &&
    importedSavedAt >= payload.savedAt &&
    keychainSecretExists(SLACK_KEYCHAIN_SERVICE, accountKey);
  if (alreadyImported) {
    return {
      platform: "slack",
      accountKey,
      sourcePath: payload.sourcePath,
      imported: false,
    };
  }

  storeSecretInKeychain(SLACK_KEYCHAIN_SERVICE, accountKey, {
    token: payload.token,
    cookie: payload.cookie,
    teamId: payload.teamId,
    teamName: payload.teamName,
    userId: payload.userId,
    savedAt: payload.savedAt,
  });

  db.upsertIntegrationState({
    platform: "slack",
    accountKey,
    displayName: payload.teamName,
    authState: existing?.auth_state ?? "requested",
    enabled: userRemoved ? true : existing ? existing.enabled === 1 : true,
    connectionKind: "browser-session",
    syncCapable: existing ? existing.sync_capable === 1 : false,
    launchStrategy: "chromium-auth",
    launchTarget: "https://slack.com/signin",
    importedFrom: payload.importMethod,
    artifactPaths: [
      ...new Set([
        payload.sourcePath,
        ...(existing?.artifact_paths_json
          ? (JSON.parse(existing.artifact_paths_json) as string[])
          : []),
      ]),
    ],
    metadata: {
      ...existingMetadata,
      authCapture: "localStorage.localConfig_v2 + cookie:d",
      authManagedBy: "chromium-runtime",
      runtimeKind: "chromium",
      supportedByDaemon: true,
      browserProfileDir: getChromiumProfileDir("slack", accountKey),
      importedSavedAt: payload.savedAt,
      importSourcePath: payload.sourcePath,
      importMethod: payload.importMethod,
      userRemoved: false,
      removedAt: null,
      disconnectedAt: null,
    },
  });

  const sessionId = db.createAuthSession({
    platform: "slack",
    accountKey,
    integrationStateId: `slack:${accountKey}`,
    state: "requested",
    requestedAt: payload.savedAt,
    resultSummary: {
      provider: "slack",
      teamId: payload.teamId,
      teamName: payload.teamName,
      userId: payload.userId,
      importMethod: payload.importMethod,
      sourcePath: payload.sourcePath,
    },
  });

  completeAuthSession(db, sessionId, {
    state: "authenticated",
    keychainService: SLACK_KEYCHAIN_SERVICE,
    keychainAccount: accountKey,
    resultSummary: {
      provider: "slack",
      teamId: payload.teamId,
      teamName: payload.teamName,
      userId: payload.userId,
      importMethod: payload.importMethod,
      sourcePath: payload.sourcePath,
    },
  });

  return {
    platform: "slack",
    accountKey,
    sourcePath: payload.sourcePath,
    imported: true,
  };
}
