import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CUED_BROWSER_DIR } from "../config.js";
import type { CuedDatabase } from "../db/database.js";
import { completeAuthSession } from "./service.js";

const LEGACY_SLACK_PREFIX = "slack_credentials_";
const LEGACY_SLACK_SUFFIX = ".enc";
const SLACK_KEYCHAIN_SERVICE = "dev.cued.auth.slack";

interface LegacySlackStoredCredentials {
  token: string;
  cookie: string;
  teamId: string;
  teamName: string;
  userId: string;
  savedAt: number;
}

export interface ImportedSlackAuthPayload {
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

interface ImportedLegacyIntegration {
  platform: "slack";
  accountKey: string;
  sourcePath: string;
  imported: boolean;
}

function getLegacyElectronUserDataDirs(): string[] {
  const configured = process.env.CUED_LEGACY_ELECTRON_USER_DATA_DIRS
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured && configured.length > 0) {
    return configured;
  }

  const appSupportDir = join(homedir(), "Library", "Application Support");
  return [
    join(appSupportDir, "@cued", "electron"),
    join(appSupportDir, "@prm", "electron"),
  ];
}

function resolveElectronBinaryPath(): string {
  return process.env.CUED_LEGACY_ELECTRON_BINARY
    ?? join(import.meta.dirname, "../../../electron/node_modules/.bin/electron");
}

function resolveDecryptHelperPath(): string {
  return process.env.CUED_LEGACY_ELECTRON_DECRYPT_SCRIPT
    ?? join(import.meta.dirname, "../../../electron/scripts/safe-storage-decrypt.mjs");
}

function getChromiumProfileDir(platform: "slack", accountKey: string): string {
  return join(CUED_BROWSER_DIR, platform, accountKey);
}

function listLegacySlackCredentialFiles(): string[] {
  const files = new Set<string>();
  for (const dir of getLegacyElectronUserDataDirs()) {
    if (!existsSync(dir)) {
      continue;
    }
    for (const name of readdirSync(dir)) {
      if (name.startsWith(LEGACY_SLACK_PREFIX) && name.endsWith(LEGACY_SLACK_SUFFIX)) {
        files.add(join(dir, name));
      }
    }
  }
  return [...files].sort();
}

function decryptLegacyFile(path: string): string {
  return execFileSync(
    resolveElectronBinaryPath(),
    [resolveDecryptHelperPath(), path],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CUED_SAFE_STORAGE_APP_NAME: process.env.CUED_SAFE_STORAGE_APP_NAME ?? "Cued",
      },
    },
  ).trim();
}

function storeSecretInKeychain(service: string, account: string, secret: Record<string, unknown>): void {
  execFileSync(
    "security",
    ["add-generic-password", "-U", "-s", service, "-a", account, "-w", JSON.stringify(secret)],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}

function keychainSecretExists(service: string, account: string): boolean {
  try {
    execFileSync(
      "security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    return true;
  } catch {
    return false;
  }
}

function parseLegacySlackCredentials(path: string): LegacySlackStoredCredentials {
  const parsed = JSON.parse(decryptLegacyFile(path)) as Partial<LegacySlackStoredCredentials>;
  if (
    typeof parsed.token !== "string"
    || typeof parsed.cookie !== "string"
    || typeof parsed.teamId !== "string"
    || typeof parsed.teamName !== "string"
    || typeof parsed.userId !== "string"
  ) {
    throw new Error(`Invalid legacy Slack credentials in ${path}`);
  }

  return {
    token: parsed.token,
    cookie: parsed.cookie,
    teamId: parsed.teamId,
    teamName: parsed.teamName,
    userId: parsed.userId,
    savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : Date.now(),
  };
}

export function upsertImportedSlackAuth(
  db: CuedDatabase,
  payload: ImportedSlackAuthPayload,
): ImportedLegacyIntegration {
  const accountKey = payload.accountKey;
  const existing = db.getIntegrationState("slack", accountKey);
  const existingMetadata = existing?.metadata_json
    ? (JSON.parse(existing.metadata_json) as Record<string, unknown>)
    : {};

  const importedSavedAt = typeof existingMetadata.importedSavedAt === "number"
    ? existingMetadata.importedSavedAt
    : null;
  const alreadyImported = existing?.auth_state === "authenticated"
    && importedSavedAt !== null
    && importedSavedAt >= payload.savedAt
    && keychainSecretExists(SLACK_KEYCHAIN_SERVICE, accountKey);
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
    artifactPaths: [...new Set([payload.sourcePath, ...(existing?.artifact_paths_json ? JSON.parse(existing.artifact_paths_json) as string[] : [])])],
    metadata: {
      ...existingMetadata,
      authCapture: "localStorage.localConfig_v2 + cookie:d",
      authManagedBy: "chromium-runtime",
      runtimeKind: "chromium",
      supportedByDaemon: true,
      browserProfileDir: getChromiumProfileDir("slack", accountKey),
      importedFromLocalAuth: true,
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

function maybeImportLegacySlackCredentials(
  db: CuedDatabase,
  path: string,
): ImportedLegacyIntegration {
  const credentials = parseLegacySlackCredentials(path);
  return upsertImportedSlackAuth(db, {
    accountKey: credentials.teamId,
    teamId: credentials.teamId,
    teamName: credentials.teamName,
    userId: credentials.userId,
    token: credentials.token,
    cookie: credentials.cookie,
    savedAt: credentials.savedAt,
    sourcePath: path,
    importMethod: "legacy-electron-auth",
  });
}

export function importLegacyLocalAuth(db: CuedDatabase): ImportedLegacyIntegration[] {
  const imported: ImportedLegacyIntegration[] = [];
  for (const path of listLegacySlackCredentialFiles()) {
    try {
      imported.push(maybeImportLegacySlackCredentials(db, path));
    } catch (error) {
      console.warn(
        `[cued integrations] failed to import legacy Slack auth from ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return imported;
}
