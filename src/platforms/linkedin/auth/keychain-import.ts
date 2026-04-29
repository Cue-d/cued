import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { CUED_BROWSER_DIR } from "../../../core/config.js";
import { safeParseJsonRecord, safeParseJsonStringArray } from "../../../db/codecs.js";
import type { CuedDatabase } from "../../../db/database.js";
import { completeAuthSession } from "../../core/state/mutations.js";
import { isUserRemovedIntegrationMetadata } from "../../core/state/status.js";
import { type LinkedInSessionSecret, parseLinkedInSessionSecret } from "./session-store.js";

const LINKEDIN_KEYCHAIN_SERVICE = "dev.cued.auth.linkedin";
const LINKEDIN_DEFAULT_ACCOUNT_KEY = "default";

export interface ImportedLinkedInSessionResult {
  platform: "linkedin";
  accountKey: string;
  imported: boolean;
}

function getChromiumProfileDir(accountKey: string): string {
  return join(CUED_BROWSER_DIR, "linkedin", accountKey);
}

function readLinkedInKeychainSecret(accountKey: string): Record<string, unknown> | null {
  try {
    const stdout = execFileSync(
      "security",
      ["find-generic-password", "-s", LINKEDIN_KEYCHAIN_SERVICE, "-a", accountKey, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getCookieNames(session: LinkedInSessionSecret): string[] {
  return session.cookies
    .map((cookie) => (typeof cookie?.name === "string" ? cookie.name : null))
    .filter((value): value is string => Boolean(value))
    .sort();
}

function hasRequiredCookies(cookieNames: readonly string[]): boolean {
  const cookieNamesSet = new Set(cookieNames);
  return cookieNamesSet.has("li_at") && cookieNamesSet.has("JSESSIONID");
}

export function importLinkedInStoredAuth(db: CuedDatabase): ImportedLinkedInSessionResult[] {
  const accountKey = LINKEDIN_DEFAULT_ACCOUNT_KEY;
  const secret = readLinkedInKeychainSecret(accountKey);
  if (!secret) {
    return [];
  }
  const parsed = parseLinkedInSessionSecret(secret);
  const cookieNames = getCookieNames(parsed);
  if (!hasRequiredCookies(cookieNames)) {
    return [];
  }

  const existing = db.getIntegrationState("linkedin", accountKey);
  const existingMetadata = existing?.metadata_json
    ? (safeParseJsonRecord(existing.metadata_json, "integration_states.metadata_json") ?? {})
    : {};
  if (isUserRemovedIntegrationMetadata(existingMetadata)) {
    return [];
  }
  const alreadyImported =
    existing?.auth_state === "authenticated" &&
    typeof existingMetadata.keychainService === "string" &&
    existingMetadata.keychainService === LINKEDIN_KEYCHAIN_SERVICE &&
    typeof existingMetadata.keychainAccount === "string" &&
    existingMetadata.keychainAccount === accountKey;
  if (alreadyImported) {
    return [{ platform: "linkedin", accountKey, imported: false }];
  }

  db.upsertIntegrationState({
    platform: "linkedin",
    accountKey,
    displayName: existing?.display_name ?? "LinkedIn",
    authState: existing?.auth_state ?? "requested",
    enabled: existing ? existing.enabled === 1 : true,
    connectionKind: "browser-session",
    syncCapable: existing ? existing.sync_capable === 1 : true,
    launchStrategy: "chromium-auth",
    launchTarget: "https://www.linkedin.com/login",
    importedFrom: existing?.imported_from ?? "local-keychain",
    artifactPaths: safeParseJsonStringArray(
      existing?.artifact_paths_json ?? null,
      "integration_states.artifact_paths_json",
    ),
    metadata: {
      ...existingMetadata,
      authCapture: "cookies:li_at,JSESSIONID",
      authManagedBy: "chromium-runtime",
      runtimeKind: "chromium",
      supportedByDaemon: true,
      browserProfileDir: getChromiumProfileDir(accountKey),
      keychainService: LINKEDIN_KEYCHAIN_SERVICE,
      keychainAccount: accountKey,
      importedSavedAt: parsed.savedAt,
      importedFromKeychain: true,
    },
  });

  const sessionId = db.createAuthSession({
    platform: "linkedin",
    accountKey,
    integrationStateId: `linkedin:${accountKey}`,
    state: "requested",
    requestedAt: parsed.savedAt ?? Date.now(),
    resultSummary: {
      provider: "linkedin",
      savedAt: parsed.savedAt,
      cookieNames,
    },
  });

  completeAuthSession(db, sessionId, {
    state: "authenticated",
    keychainService: LINKEDIN_KEYCHAIN_SERVICE,
    keychainAccount: accountKey,
    resultSummary: {
      provider: "linkedin",
      savedAt: parsed.savedAt,
      cookieNames,
    },
  });

  return [{ platform: "linkedin", accountKey, imported: true }];
}
