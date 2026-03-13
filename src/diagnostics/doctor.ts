import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_CHAT_DB_PATH, IMessageReader } from "../adapters/imessage/reader.js";
import { listAdapterPlatforms } from "../adapters/registry.js";
import type { CuedDatabase } from "../db/database.js";
import { listIntegrationStates } from "../integrations/service.js";
import {
  getSignalConfigDir,
  isSignalCliVersionSupported,
  parseSignalCliVersion,
  readSignalLinkedAccount,
  resolveSignalCliPath,
} from "../integrations/signal-cli.js";
import {
  getWhatsAppStoreDir,
  inspectWhatsAppHelper,
  readWhatsAppHelperStatus,
} from "../integrations/whatsapp-helper.js";
import { resolveMacOSNativeBinary } from "../workers/native-binary.js";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warning" | "error" | "unknown";
  summary: string;
  details?: unknown;
  remediation?: string;
}

export interface DoctorRuntimeStatus {
  signalRealtimeSessions?: unknown;
  whatsappRealtimeSessions?: unknown;
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
          : checks.contacts.status === "unknown"
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

export async function buildPermissionStatus(): Promise<{ permissions: PermissionStatusSummary[] }> {
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
      ? getMessagesAutomationCheck()
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

function getMessagesAutomationCheck(): DoctorCheck {
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

    return {
      name: "messages_automation",
      status: "ok",
      summary: "Apple Events automation access for Messages is available",
    };
  } catch (error) {
    return {
      name: "messages_automation",
      status: "warning",
      summary: "Apple Events automation for Messages is not verified",
      details: {
        error: error instanceof Error ? error.message : String(error),
      },
      remediation: "Run `cued permissions request --messages` to trigger the Automation prompt.",
    };
  }
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

export async function buildDoctorReport(
  db: CuedDatabase,
  runtime: DoctorRuntimeStatus = {},
): Promise<Record<string, unknown>> {
  const checks: DoctorCheck[] = [];

  if (process.platform === "darwin") {
    checks.push(getContactsPermissionCheck());
    checks.push(tryReadMessagesDatabase());
    checks.push(getMessagesNativeHelperCheck());
    checks.push(getMessagesAutomationCheck());
  }
  checks.push(getSignalCliCheck());
  checks.push(getSignalLinkCheck());
  checks.push(await getWhatsAppHelperCheck());
  checks.push(await getWhatsAppLinkCheck());

  return {
    daemon: db.getDaemonState(),
    overview: db.getOverview(),
    projection: db.getProjectionBacklog(),
    checkpoints: db.listCheckpointSummary(),
    recentRuns: db.listRecentRuns(),
    signalRealtimeSessions: runtime.signalRealtimeSessions ?? [],
    whatsappRealtimeSessions: runtime.whatsappRealtimeSessions ?? [],
    registeredAdapters: listAdapterPlatforms(),
    integrations: listIntegrationStates(db),
    checks,
  };
}
