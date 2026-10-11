import { safeParseJsonRecord, safeParseJsonStringArray } from "../../../db/codecs.js";
import type { CuedDatabase } from "../../../db/database.js";
import { getChromiumProfileDir } from "../../core/runtime-paths.js";
import {
  authKeychainService,
  legacyAuthKeychainService,
  loadKeychainSecret,
  storeKeychainSecret,
} from "../../core/secrets/keychain.js";
import { completeAuthSession } from "../../core/state/mutations.js";
import { isUserRemovedIntegrationMetadata } from "../../core/state/status.js";
import { LinkedInClient } from "../api/client.js";
import { LinkedInAuthError } from "../api/request.js";
import {
  buildLinkedInRealtimeAuthResult,
  type LinkedInSessionSecret,
  parseLinkedInSessionSecret,
} from "./session-store.js";

const LINKEDIN_KEYCHAIN_SERVICE = authKeychainService("linkedin");
const LEGACY_LINKEDIN_KEYCHAIN_SERVICE = legacyAuthKeychainService("linkedin");
const LINKEDIN_DEFAULT_ACCOUNT_KEY = "default";
const DEFAULT_LINKEDIN_AUTH_VALIDATION_TIMEOUT_MS = 5_000;

export interface ImportedLinkedInSessionResult {
  platform: "linkedin";
  accountKey: string;
  imported: boolean;
}

export type LinkedInStoredAuthValidation =
  | { status: "valid" }
  | { status: "invalid" }
  | { status: "indeterminate"; errorSummary: string };

function readLinkedInKeychainSecret(accountKey: string): Record<string, unknown> | null {
  const current = loadKeychainSecret(LINKEDIN_KEYCHAIN_SERVICE, accountKey);
  if (current) {
    return current;
  }
  const legacy = loadKeychainSecret(LEGACY_LINKEDIN_KEYCHAIN_SERVICE, accountKey);
  if (legacy) {
    storeKeychainSecret(LINKEDIN_KEYCHAIN_SERVICE, accountKey, legacy);
  }
  return legacy;
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

function getLinkedInAuthValidationTimeoutMs(): number {
  const configured = Number(process.env.CUED_LINKEDIN_AUTH_VALIDATION_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.trunc(configured)
    : DEFAULT_LINKEDIN_AUTH_VALIDATION_TIMEOUT_MS;
}

export async function validateLinkedInStoredAuth(
  accountKey: string,
): Promise<LinkedInStoredAuthValidation> {
  const secret = readLinkedInKeychainSecret(accountKey);
  if (!secret) {
    return { status: "invalid" };
  }

  const session = parseLinkedInSessionSecret(secret);
  if (!hasRequiredCookies(getCookieNames(session))) {
    return { status: "invalid" };
  }

  const client = new LinkedInClient({
    cookies: session.cookies,
    userAgent: session.userAgent ?? undefined,
    pageInstance: session.pageInstance ?? undefined,
    xLiTrack: session.xLiTrack ?? undefined,
  });
  try {
    await client.verifySession(AbortSignal.timeout(getLinkedInAuthValidationTimeoutMs()));
    return { status: "valid" };
  } catch (error) {
    if (error instanceof LinkedInAuthError) {
      return { status: "invalid" };
    }
    return {
      status: "indeterminate",
      errorSummary: error instanceof Error ? error.message : String(error),
    };
  }
}

export function importLinkedInStoredAuth(
  db: CuedDatabase,
  options: { reviveUserRemoved?: boolean } = {},
): ImportedLinkedInSessionResult[] {
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
  // A cached secret is not evidence that credentials rejected by LinkedIn work
  // again. Only a completed authentication flow may clear this marker.
  if (existingMetadata.authInvalidatedAt != null) {
    return [];
  }
  const userRemoved = isUserRemovedIntegrationMetadata(existingMetadata);
  if (userRemoved && !options.reviveUserRemoved) {
    return [];
  }
  const realtimeAuthResult = buildLinkedInRealtimeAuthResult(parsed);
  const alreadyImported =
    existing?.auth_state === "authenticated" &&
    typeof existingMetadata.keychainService === "string" &&
    existingMetadata.keychainService === LINKEDIN_KEYCHAIN_SERVICE &&
    typeof existingMetadata.keychainAccount === "string" &&
    existingMetadata.keychainAccount === accountKey;
  if (alreadyImported) {
    const existingAuthResult =
      typeof existingMetadata.authResult === "object" && existingMetadata.authResult
        ? (existingMetadata.authResult as Record<string, unknown>)
        : {};
    if (existingAuthResult.realtimeReady !== realtimeAuthResult.realtimeReady) {
      db.upsertIntegrationState({
        platform: "linkedin",
        accountKey,
        displayName: existing.display_name,
        authState: existing.auth_state,
        enabled: existing.enabled === 1,
        connectionKind: existing.connection_kind,
        syncCapable: existing.sync_capable === 1,
        launchStrategy: existing.launch_strategy,
        launchTarget: existing.launch_target,
        importedFrom: existing.imported_from,
        artifactPaths: safeParseJsonStringArray(
          existing.artifact_paths_json,
          "integration_states.artifact_paths_json",
        ),
        metadata: {
          ...existingMetadata,
          authResult: { ...existingAuthResult, ...realtimeAuthResult },
        },
      });
    }
    return [{ platform: "linkedin", accountKey, imported: false }];
  }

  db.upsertIntegrationState({
    platform: "linkedin",
    accountKey,
    displayName: existing?.display_name ?? "LinkedIn",
    authState: existing?.auth_state ?? "requested",
    enabled: userRemoved ? true : existing ? existing.enabled === 1 : true,
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
      browserProfileDir: getChromiumProfileDir("linkedin", accountKey),
      keychainService: LINKEDIN_KEYCHAIN_SERVICE,
      keychainAccount: accountKey,
      importedSavedAt: parsed.savedAt,
      importedFromKeychain: true,
      userRemoved: false,
      removedAt: null,
      disconnectedAt: null,
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
      ...realtimeAuthResult,
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
      ...realtimeAuthResult,
    },
  });

  return [{ platform: "linkedin", accountKey, imported: true }];
}
