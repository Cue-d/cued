import type { CuedDatabase, IntegrationStateRow } from "../../../db/database.js";
import { importLinkedInStoredAuth } from "../../linkedin/auth/keychain-import.js";
import {
  getSignalConfigDir,
  inspectSignalCli,
  isSignalCliVersionSupported,
  readSignalLinkedAccount,
} from "../../signal/cli/binary.js";
import { importSlackDesktopAuth } from "../../slack/auth/desktop-import.js";
import { getWhatsAppStoreDir, inspectWhatsAppHelper } from "../../whatsapp/helper/binary.js";
import { readWhatsAppHelperStatus } from "../../whatsapp/helper/status.js";
import { listAdapterPlatforms } from "../registry.js";
import type { IntegrationAuthState } from "../types.js";
import { refreshLocalIntegrationStates } from "./local-refresh.js";
import {
  firstNonEmptyDisplayName,
  isUserRemovedIntegrationRow,
  listIntegrationStates,
  now,
  upsertManagedIntegrationState,
} from "./status.js";
import type { IntegrationStateSummary, ManagedIntegrationState } from "./types.js";

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
    displayName:
      firstNonEmptyDisplayName(linkedAccount, existing?.display_name, "Signal") ?? "Signal",
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

export async function refreshDesktopImportedIntegrations(db: CuedDatabase): Promise<{
  refreshed: number;
  integrations: IntegrationStateSummary[];
}> {
  const importedDesktop = await importSlackDesktopAuth(db);
  const importedLinkedIn = importLinkedInStoredAuth(db);
  return {
    refreshed:
      importedDesktop.filter((entry) => entry.imported).length +
      importedLinkedIn.filter((entry) => entry.imported).length,
    integrations: listIntegrationStates(db),
  };
}

export async function refreshManagedHelperIntegrationStates(db: CuedDatabase): Promise<{
  refreshed: number;
  integrations: IntegrationStateSummary[];
}> {
  const existingStates = db.listIntegrationStates();
  let refreshed = 0;

  const signalRows = existingStates.filter((row) => row.platform === "signal");
  const activeSignalRows = signalRows.filter((row) => !isUserRemovedIntegrationRow(row));
  const signalInputs =
    activeSignalRows.length > 0 ? activeSignalRows : signalRows.length > 0 ? [] : [null];
  const signalManagedStates = (
    await Promise.all(signalInputs.map((row) => buildSignalManagedState(row)))
  ).filter((state): state is ManagedIntegrationState => Boolean(state));
  for (const integration of signalManagedStates) {
    upsertManagedIntegrationState(db, integration);
  }
  refreshed += signalManagedStates.length;

  const whatsAppRows = existingStates.filter((row) => row.platform === "whatsapp");
  const activeWhatsAppRows = whatsAppRows.filter((row) => !isUserRemovedIntegrationRow(row));
  const whatsAppInputs =
    activeWhatsAppRows.length > 0 ? activeWhatsAppRows : whatsAppRows.length > 0 ? [] : [null];
  const whatsAppManagedStates = (
    await Promise.all(whatsAppInputs.map((row) => buildWhatsAppManagedState(row)))
  ).filter((state): state is ManagedIntegrationState => Boolean(state));
  for (const integration of whatsAppManagedStates) {
    upsertManagedIntegrationState(db, integration);
  }
  refreshed += whatsAppManagedStates.length;

  return {
    refreshed,
    integrations: listIntegrationStates(db),
  };
}

export async function refreshManagedIntegrationStates(db: CuedDatabase): Promise<{
  refreshed: number;
  integrations: IntegrationStateSummary[];
}> {
  const local = refreshLocalIntegrationStates(db);
  const desktopImported = await refreshDesktopImportedIntegrations(db);
  const helpers = await refreshManagedHelperIntegrationStates(db);
  return {
    refreshed: local.refreshed + desktopImported.refreshed + helpers.refreshed,
    integrations: listIntegrationStates(db),
  };
}
