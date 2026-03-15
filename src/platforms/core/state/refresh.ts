import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DEFAULT_CHAT_DB_PATH, IMessageReader } from "../../imessage/reader.js";
import { importSlackDesktopAuth } from "../../slack/auth/desktop-import.js";
import {
  getSignalConfigDir,
  inspectSignalCli,
  isSignalCliVersionSupported,
  readSignalLinkedAccount,
} from "../../signal/cli/binary.js";
import { getWhatsAppStoreDir, inspectWhatsAppHelper } from "../../whatsapp/helper/binary.js";
import { readWhatsAppHelperStatus } from "../../whatsapp/helper/status.js";
import { resolveMacOSNativeBinary } from "../../../runtime/native-binary.js";
import type { CuedDatabase, IntegrationStateRow } from "../../../db/database.js";
import type { IntegrationAuthState } from "../types.js";
import type { IntegrationStateSummary, ManagedIntegrationState } from "./types.js";
import {
  addSupportedByDaemonMetadata,
  firstNonEmptyDisplayName,
  listIntegrationStates,
  now,
  refreshPersistedRequestableIntegrationStates,
  upsertManagedIntegrationState,
} from "./status.js";
import { listAdapterPlatforms } from "../registry.js";

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
    switch (parsed.status) {
      case "authorized":
      case "not_determined":
      case "unknown":
        return parsed.status;
      case "denied":
        return "blocked";
      default:
        return "unknown";
    }
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
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return "authorized";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("authorization denied") || message.includes("unable to open database file")) {
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
    if (message.includes("authorization denied") || message.includes("unable to open database file")) {
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
    displayName: firstNonEmptyDisplayName(linkedAccount, existing?.display_name, "Signal") ?? "Signal",
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
  let helperStatus: Awaited<ReturnType<typeof readWhatsAppHelperStatus>> | null = null;

  if (!inspected.helperPath) {
    authState = existing?.auth_state === "cancelled" ? "cancelled" : "missing";
  } else {
    try {
      helperStatus = await readWhatsAppHelperStatus(storeDir);
      accountJid = helperStatus.accountJid;
      pushName = helperStatus.pushName;
      helperVersion = helperStatus.helperVersion ?? helperVersion;
      if (helperStatus.authenticated) {
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
      whatsappLastHistorySyncAt: helperStatus?.lastHistorySyncAt ?? null,
      whatsappLastHistorySyncType: helperStatus?.lastHistorySyncType ?? null,
      whatsappLastHistoryChunkOrder: helperStatus?.lastHistoryChunkOrder ?? null,
      whatsappLastHistoryProgress: helperStatus?.lastHistoryProgress ?? null,
      whatsappQueuedHistorySyncCount: helperStatus?.queuedHistorySyncCount ?? null,
      whatsappLastHistorySyncError: helperStatus?.lastHistorySyncError ?? null,
      whatsappLastHistoryNotificationAt: helperStatus?.lastHistoryNotificationAt ?? null,
      lastVerifiedAt: now(),
    },
  };
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
