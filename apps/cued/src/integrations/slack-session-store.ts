import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { CUED_BROWSER_DIR } from "../config.js";
import type { CuedDatabase } from "../db/database.js";
import { completeAuthSession } from "./service.js";

const SLACK_KEYCHAIN_SERVICE = "dev.cued.auth.slack";

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

function getChromiumProfileDir(accountKey: string): string {
  return join(CUED_BROWSER_DIR, "slack", accountKey);
}

function storeSecretInKeychain(
  service: string,
  account: string,
  secret: Record<string, unknown>,
): void {
  execFileSync(
    "security",
    ["add-generic-password", "-U", "-s", service, "-a", account, "-w", JSON.stringify(secret)],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}

function keychainSecretExists(service: string, account: string): boolean {
  try {
    execFileSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

export function storeSlackSession(
  db: CuedDatabase,
  payload: StoredSlackSessionPayload,
): StoredSlackSessionResult {
  const accountKey = payload.accountKey;
  const existing = db.getIntegrationState("slack", accountKey);
  const existingMetadata = existing?.metadata_json
    ? (JSON.parse(existing.metadata_json) as Record<string, unknown>)
    : {};

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
    enabled: existing ? existing.enabled === 1 : true,
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
      browserProfileDir: getChromiumProfileDir(accountKey),
      importedSavedAt: payload.savedAt,
      importSourcePath: payload.sourcePath,
      importMethod: payload.importMethod,
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
