import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CuedDatabase } from "../db/database.js";
import { listAdapterPlatforms } from "../platforms/core/registry.js";
import { buildIntegrationStatus, listIntegrationStates } from "../platforms/core/state/status.js";
import { resolveGoogleOAuthClientFile } from "../platforms/gmail/oauth/client.js";
import { DEFAULT_CHAT_DB_PATH, IMessageReader } from "../platforms/imessage/reader.js";
import {
  getSignalConfigDir,
  isSignalCliVersionSupported,
  parseSignalCliVersion,
  readSignalLinkedAccount,
  resolveSignalCliPath,
} from "../platforms/signal/cli/binary.js";
import { inspectSlackHelper } from "../platforms/slack/helper/binary.js";
import { inspectWhatsAppDesktopSource } from "../platforms/whatsapp/desktop.js";
import { buildWhatsAppDiagnostics } from "../platforms/whatsapp/diagnostics.js";
import { getWhatsAppStoreDir, inspectWhatsAppHelper } from "../platforms/whatsapp/helper/binary.js";
import { readWhatsAppHelperStatus } from "../platforms/whatsapp/helper/status.js";
import type { WhatsAppRealtimeStatus } from "../platforms/whatsapp/realtime/session.js";
import { resolveMacOSNativeBinary } from "./native-binary.js";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warning" | "error" | "unknown";
  summary: string;
  details?: unknown;
  remediation?: string;
}

export interface DoctorRuntimeStatus {
  discordRealtimeSessions?: unknown;
  slackRealtimeSessions?: unknown;
  linkedinRealtimeSessions?: unknown;
  signalRealtimeSessions?: unknown;
  whatsappRealtimeSessions?: unknown;
}

export interface AuthDiagnostic {
  platform: string;
  accountKey: string;
  displayName: string | null;
  authState: string;
  enabled: boolean;
  runtimeKind: string;
  launchStrategy: string | null;
  authCapture: string | null;
  credentialSource: string;
  keychain: {
    service: string | null;
    account: string | null;
    status: "present" | "missing" | "not_configured" | "error" | "not_checked";
  };
  checks: string[];
  remediation?: string;
}

export type PermissionStatusKey = "contacts" | "full_disk_access" | "messages_automation";
export type PermissionStatusState = "granted" | "needs_action" | "unknown";

export interface PermissionStatusSummary {
  key: PermissionStatusKey;
  status: PermissionStatusState;
  summary: string;
  requestFlags: string[];
}

export interface PermissionCheckSummaryInput {
  contacts: DoctorCheck;
  messagesAutomation: DoctorCheck;
  messagesDatabase: DoctorCheck;
  messagesNativeHelper: DoctorCheck;
}

export type PermissionStatusMode = "active" | "passive";

type PermissionStatusDatabase = Pick<
  CuedDatabase,
  "getMessagesAutomationVerification" | "setMessagesAutomationVerification"
>;

export interface BuildPermissionStatusOptions {
  mode?: PermissionStatusMode;
  db?: PermissionStatusDatabase | null;
}

export function summarizePermissionStatuses(
  checks: PermissionCheckSummaryInput,
): PermissionStatusSummary[] {
  const fullDiskStatus: PermissionStatusState =
    checks.messagesDatabase.status === "error" || checks.messagesNativeHelper.status === "error"
      ? "needs_action"
      : checks.messagesDatabase.status === "ok" &&
          (checks.messagesNativeHelper.status === "ok" ||
            checks.messagesNativeHelper.status === "unknown")
        ? "granted"
        : "unknown";

  const fullDiskSummary =
    checks.messagesDatabase.status === "error"
      ? checks.messagesDatabase.summary
      : checks.messagesNativeHelper.status === "error"
        ? checks.messagesNativeHelper.summary
        : checks.messagesDatabase.status === "ok"
          ? "Full Disk Access is available for Messages data"
          : "Full Disk Access has not been verified yet";

  return [
    {
      key: "contacts",
      status:
        checks.contacts.status === "ok"
          ? "granted"
          : checks.contacts.status === "unknown" || checks.contacts.status === "warning"
            ? "unknown"
            : "needs_action",
      summary: checks.contacts.summary,
      requestFlags: ["--contacts"],
    },
    {
      key: "full_disk_access",
      status: fullDiskStatus,
      summary: fullDiskSummary,
      requestFlags: ["--full-disk-access"],
    },
    {
      key: "messages_automation",
      status:
        checks.messagesAutomation.status === "ok"
          ? "granted"
          : checks.messagesAutomation.status === "unknown"
            ? "unknown"
            : "needs_action",
      summary: checks.messagesAutomation.summary,
      requestFlags: ["--messages"],
    },
  ];
}

export async function buildPermissionStatus(
  options: BuildPermissionStatusOptions = {},
): Promise<{ permissions: PermissionStatusSummary[] }> {
  const mode = options.mode ?? "passive";
  const contacts =
    process.platform === "darwin"
      ? getContactsPermissionCheck()
      : ({
          name: "contacts_permission",
          status: "unknown",
          summary: "Contacts permission can only be checked on macOS",
        } satisfies DoctorCheck);
  const messagesDatabase =
    process.platform === "darwin"
      ? tryReadMessagesDatabase()
      : ({
          name: "messages_database",
          status: "unknown",
          summary: "Messages database access can only be checked on macOS",
        } satisfies DoctorCheck);
  const messagesNativeHelper =
    process.platform === "darwin"
      ? getMessagesNativeHelperCheck()
      : ({
          name: "messages_native_helper",
          status: "unknown",
          summary: "Native Messages access can only be checked on macOS",
        } satisfies DoctorCheck);
  const messagesAutomation =
    process.platform === "darwin"
      ? getMessagesAutomationPermissionCheck(mode, options.db)
      : ({
          name: "messages_automation",
          status: "unknown",
          summary: "Messages automation can only be checked on macOS",
        } satisfies DoctorCheck);

  return {
    permissions: summarizePermissionStatuses({
      contacts,
      messagesAutomation,
      messagesDatabase,
      messagesNativeHelper,
    }),
  };
}

function tryReadMessagesDatabase(): DoctorCheck {
  if (!existsSync(DEFAULT_CHAT_DB_PATH)) {
    return {
      name: "messages_database",
      status: "error",
      summary: "Messages database was not found",
      details: { path: DEFAULT_CHAT_DB_PATH },
      remediation: "Open Messages once on this Mac, then rerun doctor.",
    };
  }

  try {
    const reader = new IMessageReader(DEFAULT_CHAT_DB_PATH);
    try {
      const maxRowId = reader.getMaxMessageRowid();
      return {
        name: "messages_database",
        status: "ok",
        summary: "Messages database is readable",
        details: {
          path: DEFAULT_CHAT_DB_PATH,
          maxRowId,
        },
      };
    } finally {
      reader.close();
    }
  } catch (error) {
    return {
      name: "messages_database",
      status: "error",
      summary: "Messages database is not readable from the current process",
      details: {
        path: DEFAULT_CHAT_DB_PATH,
        error: error instanceof Error ? error.message : String(error),
      },
      remediation:
        "Grant Full Disk Access to the app that runs cued, then restart that app and rerun doctor.",
    };
  }
}

function getMessagesNativeHelperCheck(): DoctorCheck {
  const nativeBinary = resolveMacOSNativeBinary(process.env.CUED_IMESSAGE_NATIVE_BINARY);
  if (!nativeBinary) {
    return {
      name: "messages_native_helper",
      status: "unknown",
      summary:
        "Native Messages helper is not built, so daemon access is using the current process identity",
      remediation:
        "Use the packaged Cued.app or run `cued permissions request --full-disk-access` after rebuilding the native helper in development.",
    };
  }

  try {
    execFileSync(
      nativeBinary,
      ["imessage", "dump", "--db-path", DEFAULT_CHAT_DB_PATH, "--after-rowid", "0", "--limit", "1"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    return {
      name: "messages_native_helper",
      status: "ok",
      summary: "Native Messages helper can read the Messages database",
      details: { binary: nativeBinary },
    };
  } catch (error) {
    return {
      name: "messages_native_helper",
      status: "error",
      summary: "Native Messages helper cannot read the Messages database",
      details: {
        binary: nativeBinary,
        error: error instanceof Error ? error.message : String(error),
      },
      remediation:
        "Grant Full Disk Access to the app or binary that the daemon actually launches, then restart it. If you rebuilt the app or native helper, re-grant access because ad-hoc signatures can change the macOS privacy identity.",
    };
  }
}

function getContactsPermissionCheck(): DoctorCheck {
  const nativeBinary = resolveMacOSNativeBinary(process.env.CUED_CONTACTS_NATIVE_BINARY);
  if (!nativeBinary) {
    return {
      name: "contacts_permission",
      status: "unknown",
      summary: "Native macOS helper is not built, so Contacts permission could not be checked",
      remediation:
        "Run `cued permissions request --contacts` or rebuild the native helper in development.",
    };
  }

  try {
    const stdout = execFileSync(nativeBinary, ["contacts", "status"], {
      encoding: "utf8",
    });
    const parsed = JSON.parse(stdout) as { status?: string };
    const status = parsed.status ?? "unknown";

    if (status === "authorized") {
      return {
        name: "contacts_permission",
        status: "ok",
        summary: "Contacts access is authorized",
        details: { binary: nativeBinary },
      };
    }

    return {
      name: "contacts_permission",
      status: status === "not_determined" ? "warning" : "error",
      summary: `Contacts access is ${status.replaceAll("_", " ")}`,
      details: { binary: nativeBinary },
      remediation: "Run `cued permissions request --contacts` to trigger the prompt.",
    };
  } catch (error) {
    return {
      name: "contacts_permission",
      status: "error",
      summary: "Contacts permission check failed",
      details: {
        binary: nativeBinary,
        error: error instanceof Error ? error.message : String(error),
      },
      remediation: "Run `cued permissions request --contacts` and confirm the macOS prompt.",
    };
  }
}

function readCachedMessagesAutomationCheck(db?: PermissionStatusDatabase | null): DoctorCheck {
  const cached = db?.getMessagesAutomationVerification() ?? null;
  if (cached?.status === "granted") {
    return {
      name: "messages_automation",
      status: "ok",
      summary:
        cached.summary ?? "Apple Events automation access for Messages was previously verified",
      details: {
        checkedAt: cached.checkedAt,
        verifiedAt: cached.verifiedAt,
        source: "cached_verification",
      },
    };
  }

  return {
    name: "messages_automation",
    status: "unknown",
    summary: "Messages automation has not been explicitly verified yet",
    remediation: "Run `cued permissions request --messages` or `cued permissions doctor`.",
  };
}

function storeMessagesAutomationVerification(
  db: PermissionStatusDatabase | null | undefined,
  check: DoctorCheck,
): void {
  if (!db) {
    return;
  }

  const checkedAt = Date.now();
  if (check.status === "ok") {
    db.setMessagesAutomationVerification({
      status: "granted",
      checkedAt,
      verifiedAt: checkedAt,
      summary: check.summary,
    });
    return;
  }

  db.setMessagesAutomationVerification({
    status: "unknown",
    checkedAt,
    verifiedAt: null,
    summary: check.summary,
  });
}

export function refreshMessagesAutomationVerification(
  db?: PermissionStatusDatabase | null,
): DoctorCheck {
  try {
    execFileSync(
      "osascript",
      [
        "-e",
        "with timeout of 1 second",
        "-e",
        'tell application "Messages" to count of services',
        "-e",
        "end timeout",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const check = {
      name: "messages_automation",
      status: "ok",
      summary: "Apple Events automation access for Messages is available",
    } satisfies DoctorCheck;
    storeMessagesAutomationVerification(db, check);
    return check;
  } catch (error) {
    const check = {
      name: "messages_automation",
      status: "warning",
      summary: "Apple Events automation for Messages is not verified",
      details: {
        error: error instanceof Error ? error.message : String(error),
      },
      remediation: "Run `cued permissions request --messages` to trigger the Automation prompt.",
    } satisfies DoctorCheck;
    storeMessagesAutomationVerification(db, check);
    return check;
  }
}

function getMessagesAutomationPermissionCheck(
  mode: PermissionStatusMode,
  db?: PermissionStatusDatabase | null,
): DoctorCheck {
  if (mode === "passive") {
    return readCachedMessagesAutomationCheck(db);
  }

  return refreshMessagesAutomationVerification(db);
}

function getSignalCliCheck(): DoctorCheck {
  const cliPath = resolveSignalCliPath();
  if (!cliPath) {
    return {
      name: "signal_cli",
      status: "warning",
      summary: "Bundled Signal helper is not available",
      remediation:
        "Rebuild or update Cued so the bundled Signal helper is present, then rerun `cued integrations connect signal`.",
    };
  }

  try {
    const helperRoot = dirname(cliPath);
    const javaHome = join(helperRoot, "jre", "Contents", "Home");
    const stdout = execFileSync(cliPath, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const version = parseSignalCliVersion(stdout);
    const supported = isSignalCliVersionSupported(version);
    return {
      name: "signal_cli",
      status: supported ? "ok" : "warning",
      summary: supported
        ? `Bundled Signal helper ${version?.raw ?? "unknown"} detected`
        : `Bundled Signal helper ${version?.raw ?? "unknown"} is below the supported version floor`,
      details: {
        cliPath,
        helperRoot,
        javaHome,
        version: version?.raw ?? null,
      },
      remediation: supported
        ? undefined
        : "Update or rebuild Cued to refresh the bundled Signal helper, then reconnect Signal.",
    };
  } catch (error) {
    return {
      name: "signal_cli",
      status: "error",
      summary: "Bundled Signal helper exists but could not be executed",
      details: {
        cliPath,
        helperRoot: dirname(cliPath),
        javaHome: join(dirname(cliPath), "jre", "Contents", "Home"),
        error: error instanceof Error ? error.message : String(error),
      },
      remediation:
        "Rebuild or update Cued; the bundled Signal helper or runtime is missing required files.",
    };
  }
}

function getSignalLinkCheck(): DoctorCheck {
  const configDir = getSignalConfigDir("default");
  const linkedAccount = readSignalLinkedAccount(configDir);
  return {
    name: "signal_link",
    status: linkedAccount ? "ok" : "unknown",
    summary: linkedAccount
      ? `Signal is linked as ${linkedAccount}`
      : "No linked Signal account was found in Cued's managed config",
    details: {
      configDir,
      linkedAccount,
    },
    remediation: linkedAccount
      ? undefined
      : "Run `cued integrations connect signal` to link a Signal device.",
  };
}

function getSlackHelperCheck(): DoctorCheck {
  const inspected = inspectSlackHelper();
  if (!inspected.helperPath) {
    return {
      name: "slack_helper",
      status: "warning",
      summary: "Bundled Slack helper is not available",
      remediation: "Build native/helpers/slack-go or use the packaged app bundle.",
    };
  }

  return {
    name: "slack_helper",
    status: inspected.versionSupported ? "ok" : "warning",
    summary: inspected.versionSupported
      ? `Bundled Slack helper ${inspected.version ?? "unknown"} detected`
      : "Bundled Slack helper exists but its version or protocol is invalid",
    details: {
      helperPath: inspected.helperPath,
      version: inspected.version,
      protocolVersion: inspected.protocolVersion,
    },
    remediation: inspected.versionSupported
      ? undefined
      : "Rebuild or update Cued so the Slack helper matches the supported protocol.",
  };
}

async function getWhatsAppHelperCheck(): Promise<DoctorCheck> {
  const inspected = inspectWhatsAppHelper();
  if (!inspected.helperPath) {
    return {
      name: "whatsapp_helper",
      status: "warning",
      summary: "WhatsApp helper is not built",
      remediation: "Build native/helpers/whatsapp-go or use the packaged app bundle.",
    };
  }

  return {
    name: "whatsapp_helper",
    status: inspected.version ? "ok" : "warning",
    summary: inspected.version
      ? `WhatsApp helper ${inspected.version} detected`
      : "WhatsApp helper exists but its version could not be read",
    details: {
      helperPath: inspected.helperPath,
      version: inspected.version,
    },
    remediation: inspected.version ? undefined : "Rebuild the WhatsApp helper and rerun doctor.",
  };
}

async function getWhatsAppLinkCheck(): Promise<DoctorCheck> {
  const storeDir = getWhatsAppStoreDir("default");
  try {
    const status = await readWhatsAppHelperStatus(storeDir);
    return {
      name: "whatsapp_link",
      status: status.authenticated ? "ok" : "unknown",
      summary: status.authenticated
        ? `WhatsApp is linked as ${status.accountJid ?? "unknown"}`
        : "No linked WhatsApp account was found in Cued's managed store",
      details: {
        storeDir,
        accountJid: status.accountJid,
        pushName: status.pushName,
        helperVersion: status.helperVersion,
      },
      remediation: status.authenticated
        ? undefined
        : "Run `cued integrations connect whatsapp` to link a WhatsApp device.",
    };
  } catch (error) {
    return {
      name: "whatsapp_link",
      status: "warning",
      summary: "WhatsApp helper status check failed",
      details: {
        storeDir,
        error: error instanceof Error ? error.message : String(error),
      },
      remediation: "Rebuild the WhatsApp helper or reconnect WhatsApp.",
    };
  }
}

async function getWhatsAppDesktopDatabaseCheck(): Promise<DoctorCheck> {
  try {
    const inspected = inspectWhatsAppDesktopSource();
    if (!inspected.available) {
      return {
        name: "whatsapp_desktop_database",
        status: "unknown",
        summary: "WhatsApp Desktop database was not found",
        details: inspected,
        remediation: "Install or open WhatsApp Desktop, then grant Full Disk Access to Cued.",
      };
    }
    return {
      name: "whatsapp_desktop_database",
      status: inspected.messageRows > 0 ? "ok" : "warning",
      summary:
        inspected.messageRows > 0
          ? `WhatsApp Desktop database is readable with ${inspected.messageRows} messages`
          : "WhatsApp Desktop database is readable but contains no messages",
      details: inspected,
      remediation:
        inspected.messageRows > 0
          ? undefined
          : "Open WhatsApp Desktop and wait for recent chats to load before importing history.",
    };
  } catch (error) {
    return {
      name: "whatsapp_desktop_database",
      status: "warning",
      summary: "WhatsApp Desktop database is not readable",
      details: {
        error: error instanceof Error ? error.message : String(error),
      },
      remediation: "Grant Full Disk Access to Cued or the current terminal and rerun doctor.",
    };
  }
}

function getKeychainItemStatus(
  service: string | null,
  account: string | null,
): AuthDiagnostic["keychain"]["status"] {
  if (!service || !account) {
    return "not_configured";
  }

  try {
    execFileSync("security", ["find-generic-password", "-s", service, "-a", account], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return "present";
  } catch (error) {
    const status =
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : null;
    return status === 44 ? "missing" : "error";
  }
}

function inferCredentialSource(input: {
  platform: string;
  importedFrom: string | null;
  authCapture: string | null;
  runtimeKind: string;
  importMethod: string | null;
}): string {
  if (input.platform === "contacts" || input.platform === "imessage") {
    return "macos_permission";
  }
  if (input.platform === "gmail") {
    return "google_oauth_loopback_pkce";
  }
  if (input.platform === "whatsapp") {
    return "whatsapp_linked_device_store";
  }
  if (input.platform === "signal") {
    return "signal_cli_linked_device_config";
  }
  if (input.importMethod) {
    return input.importMethod;
  }
  if (input.importedFrom) {
    return input.importedFrom;
  }
  return input.authCapture ?? input.runtimeKind;
}

function getAuthDiagnosticRemediation(checks: string[]): string | undefined {
  if (checks.includes("missing_google_oauth_client")) {
    return "Install an official Cued build with bundled Gmail OAuth credentials, add a Google OAuth client JSON at ~/.cued/google-oauth-client.json, or set CUED_GOOGLE_OAUTH_CLIENT_FILE.";
  }
  if (checks.includes("keychain_item_missing")) {
    return "Reconnect this integration so Cued can store fresh credentials for the recorded account.";
  }
  if (checks.includes("linked_device_missing")) {
    return "Reconnect this integration from onboarding or `cued integrations connect <platform>`.";
  }
  if (checks.includes("managed_browser_fallback_used")) {
    return "Prefer existing Keychain or installed-app import before opening a managed browser.";
  }
  return undefined;
}

export function buildAuthDiagnostics(db: CuedDatabase): AuthDiagnostic[] {
  const status = buildIntegrationStatus(db, { includeLiveLocalIntegrations: false });
  const byIdentity = new Map<string, (typeof status.integrations)[number]>();
  for (const integration of [...status.integrations, ...status.setupIntegrations]) {
    byIdentity.set(`${integration.platform}:${integration.accountKey}`, integration);
  }

  const googleOAuthClientFile = resolveGoogleOAuthClientFile();
  const googleOAuthClientExists = existsSync(googleOAuthClientFile);

  return [...byIdentity.values()].map((integration) => {
    const metadata = integration.metadata ?? {};
    const keychainService =
      typeof metadata.keychainService === "string" ? metadata.keychainService : null;
    const keychainAccount =
      typeof metadata.keychainAccount === "string" ? metadata.keychainAccount : null;
    const authCapture = typeof metadata.authCapture === "string" ? metadata.authCapture : null;
    const importMethod = typeof metadata.importMethod === "string" ? metadata.importMethod : null;
    const runtimeKind =
      typeof metadata.runtimeKind === "string" ? metadata.runtimeKind : integration.runtimeKind;
    const keychainStatus = getKeychainItemStatus(keychainService, keychainAccount);
    const checks: string[] = [];

    if (integration.authState !== "authenticated" && integration.authState !== "authorized") {
      checks.push(`auth_state_${integration.authState}`);
    }
    if (keychainService && keychainAccount && keychainStatus === "missing") {
      checks.push("keychain_item_missing");
    } else if (keychainService && keychainAccount && keychainStatus === "error") {
      checks.push("keychain_check_error");
    }
    if (integration.platform === "gmail" && !googleOAuthClientExists) {
      checks.push("missing_google_oauth_client");
    }
    if (
      integration.platform === "linkedin" &&
      integration.authState === "authenticated" &&
      (metadata.authResult as { realtimeReady?: unknown } | undefined)?.realtimeReady !== true
    ) {
      checks.push("linkedin_realtime_headers_missing");
    }
    if (
      integration.platform === "slack" &&
      integration.authState === "authenticated" &&
      integration.importedFrom !== "slack-desktop-cdp"
    ) {
      checks.push("managed_browser_fallback_used");
    }
    if (
      (integration.platform === "whatsapp" || integration.platform === "signal") &&
      integration.authState !== "authenticated"
    ) {
      checks.push("linked_device_missing");
    }

    return {
      platform: integration.platform,
      accountKey: integration.accountKey,
      displayName: integration.displayName,
      authState: integration.authState,
      enabled: integration.enabled,
      runtimeKind,
      launchStrategy: integration.launchStrategy,
      authCapture,
      credentialSource: inferCredentialSource({
        platform: integration.platform,
        importedFrom: integration.importedFrom,
        authCapture,
        runtimeKind,
        importMethod,
      }),
      keychain: {
        service: keychainService,
        account: keychainAccount,
        status: keychainStatus,
      },
      checks,
      remediation: getAuthDiagnosticRemediation(checks),
    };
  });
}

export async function buildDoctorReport(
  db: CuedDatabase,
  runtime: DoctorRuntimeStatus = {},
): Promise<Record<string, unknown>> {
  const checks: DoctorCheck[] = [];

  if (process.platform === "darwin") {
    checks.push(getContactsPermissionCheck());
    checks.push(tryReadMessagesDatabase());
    checks.push(getMessagesNativeHelperCheck());
    checks.push(refreshMessagesAutomationVerification(db));
  }
  checks.push(getSignalCliCheck());
  checks.push(getSignalLinkCheck());
  checks.push(getSlackHelperCheck());
  checks.push(await getWhatsAppHelperCheck());
  checks.push(await getWhatsAppLinkCheck());
  checks.push(await getWhatsAppDesktopDatabaseCheck());

  return {
    daemon: db.getDaemonState(),
    overview: db.getOverview(),
    projection: db.getProjectionBacklog(),
    checkpoints: db.listCheckpointSummary(),
    recentRuns: db.listRecentRuns(),
    discordRealtimeSessions: runtime.discordRealtimeSessions ?? [],
    slackRealtimeSessions: runtime.slackRealtimeSessions ?? [],
    linkedinRealtimeSessions: runtime.linkedinRealtimeSessions ?? [],
    signalRealtimeSessions: runtime.signalRealtimeSessions ?? [],
    whatsappRealtimeSessions: runtime.whatsappRealtimeSessions ?? [],
    whatsappDiagnostics: buildWhatsAppDiagnostics(
      db,
      (runtime.whatsappRealtimeSessions as WhatsAppRealtimeStatus[] | undefined) ?? [],
    ),
    registeredAdapters: listAdapterPlatforms(),
    integrations: listIntegrationStates(db),
    auth: buildAuthDiagnostics(db),
    checks,
  };
}
