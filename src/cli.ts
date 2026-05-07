#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ActionDefinitionRegistry, actionRequiresProjectionRebuild } from "./actions/registry.js";
import { type DaemonRequestInput, DaemonRequestTimeoutError, sendDaemonRequest } from "./client.js";
import { getCurrentAppVersion, getCurrentReleaseChannel } from "./core/app-metadata.js";
import {
  CUED_DB_PATH,
  CUED_MENU_BAR_STATUS_PATH,
  CUED_SOCKET_PATH,
  ensureCuedDirs,
} from "./core/config.js";
import { resolveHostOS } from "./core/platform-capabilities.js";
import {
  openCuedDatabase,
  openCuedDatabaseReadOnly,
  openExistingCuedDatabase,
} from "./db/database.js";
import {
  disableLoginItem,
  enableLoginItem,
  getAppBundleInfo,
  getCLISymlinkStatus,
  getLoginItemStatus,
  installCLISymlink,
  installMacOSApp,
  resolveInstalledAppPath,
} from "./macos/install.js";
import { IntegrationAuthService } from "./platforms/core/auth/service.js";
import {
  getIntegrationSummary,
  listIntegrationStates,
  listMenuBarIntegrationStates,
} from "./platforms/core/state/status.js";
import {
  ACTION_STATUS_VALUES,
  type ActionStatus,
  getPlatformFeatureMatrixRow,
  getPlatformHelperRequirements,
  getPlatformPermissionRequirements,
  getSupportedHostOsForPlatform,
  isOnboardingVisiblePlatform,
  PLATFORM_VALUES,
  platformSupportsMultipleAccounts,
} from "./platforms/core/types.js";
import { runDaemon } from "./runtime/daemon/server.js";
import {
  buildDoctorReport,
  buildPermissionStatus,
  refreshMessagesAutomationVerification,
} from "./runtime/doctor.js";
import {
  doctorHooksConfig,
  emitHookEvent,
  HOOK_EVENT_NAMES,
  initHooksConfig,
  testHookEvent,
} from "./runtime/hooks.js";
import {
  followLogs,
  getDaemonLogPath,
  parseLogsCommandArgs,
  readRecentLogLines,
} from "./runtime/logs.js";
import { buildOnboardingSnapshot } from "./runtime/onboarding.js";
import { rebuildProjectedState } from "./runtime/projection/projector.js";
import { runProjectionWorkerFromEnv } from "./runtime/projection/worker.js";
import {
  checkForUpdates,
  clearUpdateHelperPendingState,
  getUpdateStatus,
  installAvailableUpdate,
  runUpdateHelperHealthCheck,
  runUpdatePreflight,
  setUpdateHelperLastError,
} from "./runtime/updater/service.js";
import { runSetupTUI } from "./setup.js";
import {
  getGlobalCuedSkillStatus,
  getLocalCuedSkillStatus,
  installGlobalCuedSkill,
  installLocalCuedSkill,
} from "./skills/install.js";

const DIST_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(DIST_ROOT, "..");

export function resolveBundledScriptPath(scriptName: string): string | null {
  const candidates = [
    process.env.CUED_BUNDLED_SCRIPT_ROOT
      ? join(process.env.CUED_BUNDLED_SCRIPT_ROOT, scriptName)
      : null,
    join(DIST_ROOT, "../scripts", scriptName),
  ].filter((value): value is string => Boolean(value));

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function resolvePermissionsScriptPath(): string {
  return (
    resolveBundledScriptPath("request-macos-access.sh") ??
    join(REPO_ROOT, "scripts", "request-macos-access.sh")
  );
}

export function normalizeInvocationPath(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : resolve(path);
  } catch {
    return resolve(path);
  }
}

export function isDirectInvocation(
  moduleUrl = import.meta.url,
  argvPath: string | undefined = process.argv[1],
): boolean {
  if (argvPath === undefined) {
    return false;
  }

  return normalizeInvocationPath(fileURLToPath(moduleUrl)) === normalizeInvocationPath(argvPath);
}

function isInvokedDirectly(): boolean {
  return isDirectInvocation();
}

function printHelp(): void {
  console.log(`cued

Usage:
  cued help
  cued install
  cued daemon
  cued status
  cued doctor
  cued logs
  cued setup
  cued update status
  cued update check [--force]
  cued update install
  cued cli install|status
  cued login-item enable|disable|status
  cued onboarding complete|snapshot|status [--refresh-managed] [--refresh-permissions]
  cued skill install-global|install-local [skill-root]|status|status-local [skill-name]
  cued permissions doctor|status|request [--all|--contacts|--messages|--full-disk-access]
  cued sql <query>
  cued actions definitions
  cued actions propose <type> --payload JSON [--version VERSION] [--title TEXT] [--summary TEXT] [--source-skill NAME] [--no-approval]
  cued actions list [--status STATUS] [--limit N]
  cued actions show <action-id>
  cued actions approve <action-id> [--by ACTOR]
  cued actions deny <action-id> [--by ACTOR]
  cued actions execute <action-id> [--by ACTOR]
  cued actions run-approved [--limit N] [--by ACTOR]
  cued integrations list
  cued integrations status
  cued integrations capabilities
  cued integrations refresh
  cued integrations connect <platform> [account]
  cued integrations disconnect <platform> [account]
  cued integrations remove <platform> [account]
  cued integrations enable <platform> [account]
  cued integrations disable <platform> [account]
  cued contacts memory add <contact-id> <memory> [--source SOURCE] [--confidence 0-100] [--evidence JSON] [--supersedes MEMORY_ID] [--execute]
  cued contacts memory list <contact-id> [--limit N] [--include-stale]
  cued contacts memory stale <memory-id> [--execute]
  cued attachments list [--message ID] [--conversation ID] [--platform PLATFORM] [--account ACCOUNT] [--limit N]
  cued attachments fetch <attachment-id> [--variant original] [--max-bytes N] [--allow-large] [--no-extract]
  cued attachments search <query> [--conversation ID] [--platform PLATFORM] [--account ACCOUNT] [--limit N]
  cued hooks init
  cued hooks doctor
  cued hooks test <event>
  cued send <platform> <target> <text> [account]
  cued sync run [source]
  cued sync resume
  cued rebuild
  cued reset --source <source>

Paths:
  db: ${CUED_DB_PATH}
  socket: ${CUED_SOCKET_PATH}
`);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function isDaemonTimeout(error: unknown): error is DaemonRequestTimeoutError {
  return error instanceof DaemonRequestTimeoutError;
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const index = args.findIndex((value) => value === flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseIntegerFlag(args: string[], flag: string): number | undefined {
  const raw = parseFlagValue(args, flag);
  if (raw === undefined) {
    return undefined;
  }
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${flag} must be an integer.`);
  }
  return Number(raw);
}

function parseJsonFlag(args: string[], flag: string): unknown {
  const raw = parseFlagValue(args, flag);
  if (raw === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `${flag} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseActionStatusFlag(args: string[], flag: string): ActionStatus | undefined {
  const raw = parseFlagValue(args, flag);
  if (raw === undefined) {
    return undefined;
  }
  if (!ACTION_STATUS_VALUES.includes(raw as ActionStatus)) {
    throw new Error(`${flag} must be one of: ${ACTION_STATUS_VALUES.join(", ")}.`);
  }
  return raw as ActionStatus;
}

function parseFreeTextArgument(args: string[], startIndex: number): string | undefined {
  const bodyTokens = args.slice(startIndex).filter((value, index, values) => {
    if (value.startsWith("--")) {
      return false;
    }
    const previous = index > 0 ? values[index - 1] : undefined;
    return previous === undefined || !previous.startsWith("--");
  });
  return bodyTokens.length > 0 ? bodyTokens.join(" ") : undefined;
}

function assertNoLegacyQueueFlag(args: string[]): void {
  if (args.includes("--queue")) {
    throw new Error("--queue was removed because contacts memory commands queue by default.");
  }
}

function getAppStatusMetadata(db: ReturnType<typeof openCuedDatabase>) {
  return {
    hostOs: resolveHostOS(),
    version: getCurrentAppVersion(),
    releaseChannel: getCurrentReleaseChannel(),
    install: db.getAppMetadata(),
  };
}

async function safeEmitHookEvent(
  event: (typeof HOOK_EVENT_NAMES)[number],
  payload: unknown,
): Promise<void> {
  try {
    await emitHookEvent(event, payload as Record<string, unknown>);
  } catch (error) {
    console.warn(
      `[cued hooks] ${event} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function buildLocalStatusFallback(error: DaemonRequestTimeoutError) {
  const cached = readCachedStatusSnapshot();
  if (cached) {
    return {
      ...cached,
      socketRunning: existsSync(CUED_SOCKET_PATH),
      daemonResponsive: false,
      daemonBusyError: error.message,
      staleCache: true,
      dbPath:
        typeof cached.dbPath === "string" && cached.dbPath.length > 0
          ? cached.dbPath
          : CUED_DB_PATH,
    };
  }
  try {
    const db = openExistingCuedDatabase(undefined, { readonly: true });
    try {
      return {
        app: getAppStatusMetadata(db),
        daemon: db.getDaemonState(),
        overview: db.getOverview(),
        projection: db.getProjectionBacklog({ initializeProjectionState: false }),
        checkpoints: db.listCheckpointSummary(),
        recentRuns: db.listRecentRuns(),
        integrations: listIntegrationStates(db),
        hooks: doctorHooksConfig(),
        update: getUpdateStatus(db),
        socketRunning: existsSync(CUED_SOCKET_PATH),
        daemonResponsive: false,
        daemonBusyError: error.message,
        dbPath: db.dbPath,
      };
    } finally {
      db.close();
    }
  } catch (fallbackError) {
    return {
      socketRunning: existsSync(CUED_SOCKET_PATH),
      daemonResponsive: false,
      daemonBusyError: error.message,
      fallbackError: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      dbPath: CUED_DB_PATH,
    };
  }
}

function readCachedStatusSnapshot(): Record<string, unknown> | null {
  try {
    if (!existsSync(CUED_MENU_BAR_STATUS_PATH)) {
      return null;
    }
    const parsed = JSON.parse(readFileSync(CUED_MENU_BAR_STATUS_PATH, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function buildLocalDoctorFallback(error: DaemonRequestTimeoutError) {
  try {
    const db = openExistingCuedDatabase(undefined, { readonly: true });
    try {
      return {
        app: getAppStatusMetadata(db),
        ...(await buildDoctorReport(db)),
        projection: db.getProjectionBacklog({ initializeProjectionState: false }),
        hooks: doctorHooksConfig(),
        update: getUpdateStatus(db),
        socketRunning: existsSync(CUED_SOCKET_PATH),
        daemonResponsive: false,
        daemonBusyError: error.message,
        dbPath: db.dbPath,
      };
    } finally {
      db.close();
    }
  } catch (fallbackError) {
    return {
      socketRunning: existsSync(CUED_SOCKET_PATH),
      daemonResponsive: false,
      daemonBusyError: error.message,
      fallbackError: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      dbPath: CUED_DB_PATH,
    };
  }
}

async function handleLocalIntegrationCommand(
  subcommand: string | undefined,
  rest: string[],
): Promise<unknown> {
  if (subcommand === "capabilities") {
    return PLATFORM_VALUES.map((platform) => ({
      platform,
      supportedHostOs: getSupportedHostOsForPlatform(platform),
      onboardingVisible: isOnboardingVisiblePlatform(platform),
      supportsMultipleAccounts: platformSupportsMultipleAccounts(platform),
      permissionRequirements: getPlatformPermissionRequirements(platform),
      helperRequirements: getPlatformHelperRequirements(platform),
      features: getPlatformFeatureMatrixRow(platform),
    }));
  }

  const db = openCuedDatabase();
  const service = new IntegrationAuthService(db);
  try {
    switch (subcommand) {
      case "list":
      case "status":
        return service.listStatus();
      case "refresh":
        return await service.refresh();
      case "connect": {
        if (!rest[0]) {
          throw new Error("Usage: cued integrations connect <platform> [account]");
        }
        return await service.connectLocally(rest[0], rest[1], {
          emitAuthenticatedHook: async (platform, accountKey) => {
            await safeEmitHookEvent("integration.authenticated", {
              integration: getIntegrationSummary(db, platform, accountKey),
            });
          },
        });
      }
      case "disconnect":
        if (!rest[0]) {
          throw new Error("Usage: cued integrations disconnect <platform> [account]");
        }
        return service.disconnect(rest[0], rest[1]);
      case "remove":
        if (!rest[0]) {
          throw new Error("Usage: cued integrations remove <platform> [account]");
        }
        return service.remove(rest[0], rest[1]);
      case "enable":
        if (!rest[0]) {
          throw new Error("Usage: cued integrations enable <platform> [account]");
        }
        return service.enable(rest[0], rest[1]);
      case "disable":
        if (!rest[0]) {
          throw new Error("Usage: cued integrations disable <platform> [account]");
        }
        return service.disable(rest[0], rest[1]);
      default:
        throw new Error(service.usage());
    }
  } finally {
    db.close();
  }
}

function isUnsupportedDaemonCommand(response: { ok: boolean; error?: string }): boolean {
  return !response.ok && response.error === "Unsupported command";
}

async function sendOptionalDaemonRequest(
  request: DaemonRequestInput,
): Promise<Awaited<ReturnType<typeof sendDaemonRequest>> | null> {
  try {
    const response = await sendDaemonRequest(request);
    return isUnsupportedDaemonCommand(response) ? null : response;
  } catch {
    return null;
  }
}

function printDaemonResultOrThrow(
  response: Awaited<ReturnType<typeof sendDaemonRequest>>,
  fallbackError: string,
): void {
  if (!response.ok) {
    throw new Error(response.error ?? fallbackError);
  }
  printJson(response.result ?? null);
}

async function printOptionalDaemonResult(
  request: DaemonRequestInput,
  fallbackError: string,
): Promise<boolean> {
  const response = await sendOptionalDaemonRequest(request);
  if (!response) {
    return false;
  }
  printDaemonResultOrThrow(response, fallbackError);
  return true;
}

async function main(): Promise<void> {
  ensureCuedDirs();

  const args = process.argv.slice(2);
  const [command, subcommand, ...rest] = args;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "daemon") {
    await runDaemon();
    return;
  }

  if (command === "__projection-worker") {
    await runProjectionWorkerFromEnv();
    return;
  }

  if (command === "setup") {
    await runSetupTUI();
    return;
  }

  if (command === "install") {
    printJson(installMacOSApp());
    return;
  }

  if (command === "update") {
    switch (subcommand) {
      case "status": {
        const db = openCuedDatabase();
        try {
          printJson(getUpdateStatus(db));
        } finally {
          db.close();
        }
        return;
      }
      case "check": {
        const db = openCuedDatabase();
        try {
          printJson(await checkForUpdates(db, { force: rest.includes("--force") }));
        } finally {
          db.close();
        }
        return;
      }
      case "install": {
        const db = openCuedDatabase();
        try {
          printJson(await installAvailableUpdate(db));
        } finally {
          db.close();
        }
        return;
      }
      case "preflight": {
        const dbPathFlagIndex = rest.findIndex((value) => value === "--db-path");
        const dbPath = dbPathFlagIndex >= 0 ? rest[dbPathFlagIndex + 1] : undefined;
        if (!dbPath) {
          throw new Error("Usage: cued update preflight --db-path <path>");
        }
        printJson(runUpdatePreflight(dbPath));
        return;
      }
      case "helper-health": {
        const dbPathFlagIndex = rest.findIndex((value) => value === "--db-path");
        const expectedVersionFlagIndex = rest.findIndex((value) => value === "--expected-version");
        const dbPath = dbPathFlagIndex >= 0 ? rest[dbPathFlagIndex + 1] : undefined;
        const expectedVersion =
          expectedVersionFlagIndex >= 0 ? rest[expectedVersionFlagIndex + 1] : undefined;
        if (!dbPath || !expectedVersion) {
          throw new Error(
            "Usage: cued update helper-health --db-path <path> --expected-version <version>",
          );
        }
        const healthy = runUpdateHelperHealthCheck(dbPath, expectedVersion);
        printJson({ healthy });
        if (!healthy) {
          process.exitCode = 1;
        }
        return;
      }
      case "helper-clear-pending": {
        const dbPathFlagIndex = rest.findIndex((value) => value === "--db-path");
        const dbPath = dbPathFlagIndex >= 0 ? rest[dbPathFlagIndex + 1] : undefined;
        if (!dbPath) {
          throw new Error("Usage: cued update helper-clear-pending --db-path <path>");
        }
        clearUpdateHelperPendingState(dbPath);
        printJson({ cleared: true });
        return;
      }
      case "helper-set-last-error": {
        const dbPathFlagIndex = rest.findIndex((value) => value === "--db-path");
        const messageFlagIndex = rest.findIndex((value) => value === "--message");
        const dbPath = dbPathFlagIndex >= 0 ? rest[dbPathFlagIndex + 1] : undefined;
        const message = messageFlagIndex >= 0 ? rest[messageFlagIndex + 1] : undefined;
        if (!dbPath) {
          throw new Error(
            "Usage: cued update helper-set-last-error --db-path <path> [--message <text>]",
          );
        }
        setUpdateHelperLastError(dbPath, message ?? null);
        printJson({ cleared: message == null });
        return;
      }
      default:
        throw new Error("Usage: cued update status | check [--force] | install");
    }
  }

  if (command === "logs") {
    const options = parseLogsCommandArgs(
      [subcommand, ...rest].filter((value): value is string => Boolean(value)),
    );
    if (options.pathOnly) {
      console.log(getDaemonLogPath());
      return;
    }
    if (options.follow) {
      await followLogs({ tail: options.tail });
      return;
    }
    const lines = readRecentLogLines(options.tail);
    if (lines.length === 0) {
      console.log(`No daemon logs found at ${getDaemonLogPath()}`);
      return;
    }
    console.log(lines.join("\n"));
    return;
  }

  if (command === "integrations" && !existsSync(CUED_SOCKET_PATH)) {
    printJson(await handleLocalIntegrationCommand(subcommand, rest));
    return;
  }

  if (command === "status" && [subcommand, ...rest].includes("--menu-bar")) {
    const db = openExistingCuedDatabase(undefined, { readonly: true });
    try {
      printJson({
        app: getAppStatusMetadata(db),
        daemon: db.getDaemonState(),
        overview: db.getMenuBarOverview(),
        integrations: listMenuBarIntegrationStates(db),
        update: getUpdateStatus(db),
        socketRunning: existsSync(CUED_SOCKET_PATH),
        dbPath: db.dbPath,
      });
    } finally {
      db.close();
    }
    return;
  }

  if ((command === "status" || command === "doctor") && !existsSync(CUED_SOCKET_PATH)) {
    const readOnlyStatus = command === "status" && [subcommand, ...rest].includes("--read-only");
    const db = readOnlyStatus
      ? openExistingCuedDatabase(undefined, { readonly: true })
      : openCuedDatabase();
    try {
      printJson(
        command === "doctor"
          ? {
              app: getAppStatusMetadata(db),
              ...(await buildDoctorReport(db)),
              projection: db.getProjectionBacklog(),
              hooks: doctorHooksConfig(),
              update: getUpdateStatus(db),
            }
          : {
              app: getAppStatusMetadata(db),
              daemon: db.getDaemonState(),
              overview: db.getOverview(),
              projection: db.getProjectionBacklog({
                initializeProjectionState: !readOnlyStatus,
              }),
              checkpoints: db.listCheckpointSummary(),
              recentRuns: db.listRecentRuns(),
              integrations: listIntegrationStates(db),
              hooks: doctorHooksConfig(),
              update: getUpdateStatus(db),
              socketRunning: false,
              dbPath: db.dbPath,
            },
      );
    } finally {
      db.close();
    }
    return;
  }

  if (command === "hooks") {
    switch (subcommand) {
      case "init":
        printJson(initHooksConfig(rest.includes("--force")));
        return;
      case "doctor":
        printJson(doctorHooksConfig());
        return;
      case "test":
        if (!rest[0] || !HOOK_EVENT_NAMES.includes(rest[0] as (typeof HOOK_EVENT_NAMES)[number])) {
          throw new Error(`Usage: cued hooks test <event>\nEvents: ${HOOK_EVENT_NAMES.join(", ")}`);
        }
        printJson(await testHookEvent(rest[0] as (typeof HOOK_EVENT_NAMES)[number]));
        return;
      default:
        throw new Error(
          `Usage: cued hooks init | doctor | test <event>\nEvents: ${HOOK_EVENT_NAMES.join(", ")}`,
        );
    }
  }

  let response: Awaited<ReturnType<typeof sendDaemonRequest>>;

  switch (command) {
    case "cli":
      switch (subcommand) {
        case "install": {
          const appPath = resolveInstalledAppPath();
          if (!appPath) {
            throw new Error("Cued.app is not installed.");
          }
          const db = openCuedDatabase();
          try {
            const cliSymlinkPath = installCLISymlink(appPath);
            db.setAppSetting("cli_symlink_installed", "1");
            printJson({
              appPath,
              cliSymlinkPath,
              status: getCLISymlinkStatus(),
            });
          } finally {
            db.close();
          }
          return;
        }
        case "status":
          printJson(getCLISymlinkStatus());
          return;
        default:
          throw new Error("Usage: cued cli install | status");
      }
    case "onboarding": {
      const refreshManaged = rest.includes("--refresh-managed");
      const refreshPermissions = rest.includes("--refresh-permissions");
      const db =
        subcommand === "snapshot" && !refreshManaged && !refreshPermissions
          ? openCuedDatabaseReadOnly()
          : openCuedDatabase();
      try {
        switch (subcommand) {
          case "complete":
            db.markOnboardingCompleted(getCurrentAppVersion());
            printJson(db.getAppMetadata());
            return;
          case "snapshot":
            printJson(
              await buildOnboardingSnapshot(db, {
                refreshManagedIntegrations: refreshManaged,
                refreshPermissions,
              }),
            );
            return;
          case "status":
            printJson(db.getAppMetadata());
            return;
          default:
            throw new Error(
              "Usage: cued onboarding complete | snapshot [--refresh-managed] [--refresh-permissions] | status",
            );
        }
      } finally {
        db.close();
      }
    }
    case "skill":
      switch (subcommand) {
        case "install-global":
          printJson(installGlobalCuedSkill());
          return;
        case "install-local":
          printJson(installLocalCuedSkill(rest[0]));
          return;
        case "status":
          printJson(getGlobalCuedSkillStatus());
          return;
        case "status-local":
          printJson(getLocalCuedSkillStatus(rest[0]));
          return;
        default:
          throw new Error(
            "Usage: cued skill install-global | install-local [skill-root] | status | status-local [skill-name]",
          );
      }
    case "login-item":
      switch (subcommand) {
        case "enable":
          printJson(enableLoginItem());
          return;
        case "disable":
          printJson(disableLoginItem());
          return;
        case "status":
          printJson(getLoginItemStatus());
          return;
        default:
          throw new Error("Usage: cued login-item enable | disable | status");
      }
    case "permissions":
      switch (subcommand) {
        case "doctor":
          {
            const db = openCuedDatabase();
            try {
              printJson({
                app: getAppBundleInfo(),
                doctor: await buildDoctorReport(db),
              });
            } finally {
              db.close();
            }
          }
          return;
        case "status":
          {
            let daemonResponse: Awaited<ReturnType<typeof sendDaemonRequest>> | null = null;
            try {
              daemonResponse = await sendDaemonRequest({ command: "permissions-status" });
            } catch {
              // Fall back for development shells or older daemons that are not running yet.
            }
            if (daemonResponse && !isUnsupportedDaemonCommand(daemonResponse)) {
              if (!daemonResponse.ok) {
                throw new Error(daemonResponse.error ?? "Daemon permissions status failed");
              }
              printJson(daemonResponse.result ?? null);
              return;
            }
            const db = openCuedDatabaseReadOnly();
            try {
              printJson(
                await buildPermissionStatus({
                  mode: "passive",
                  db,
                }),
              );
            } finally {
              db.close();
            }
          }
          return;
        case "request": {
          const flags = rest.length > 0 ? rest : ["--all"];
          const scriptPath = resolvePermissionsScriptPath();
          printJson({
            app: getAppBundleInfo(),
            requested: flags,
            command: ["bash", scriptPath, ...flags],
          });
          execFileSync("bash", [scriptPath, ...flags], { stdio: "inherit" });
          if (flags.includes("--all") || flags.includes("--messages")) {
            const db = openCuedDatabase();
            try {
              refreshMessagesAutomationVerification(db);
            } finally {
              db.close();
            }
          }
          return;
        }
        default:
          throw new Error(
            "Usage: cued permissions doctor | status | request [--all|--contacts|--messages|--full-disk-access]",
          );
      }
    case "sql": {
      const query = [subcommand, ...rest]
        .filter((value): value is string => Boolean(value))
        .join(" ");
      if (!query) {
        throw new Error("Usage: cued sql <query>");
      }
      let daemonResponse: Awaited<ReturnType<typeof sendDaemonRequest>> | null = null;
      try {
        daemonResponse = await sendDaemonRequest({ command: "sql", query });
      } catch {
        // Fall back for development shells or older daemons that are not running yet.
      }
      if (daemonResponse && !isUnsupportedDaemonCommand(daemonResponse)) {
        if (!daemonResponse.ok) {
          throw new Error(daemonResponse.error ?? "Daemon SQL query failed");
        }
        printJson(daemonResponse.result ?? null);
        return;
      }
      const db = openCuedDatabaseReadOnly();
      try {
        printJson(db.executeReadOnlySql(query));
      } finally {
        db.close();
      }
      return;
    }
    case "actions": {
      switch (subcommand) {
        case "definitions":
          printJson(ActionDefinitionRegistry.load().list());
          return;
        case "propose": {
          const actionType = rest[0];
          const actionVersion = parseFlagValue(rest, "--version") ?? "1";
          const payload = parseJsonFlag(rest, "--payload");
          if (!actionType || payload === undefined) {
            throw new Error(
              "Usage: cued actions propose <type> --payload JSON [--version VERSION] [--title TEXT] [--summary TEXT] [--source-skill NAME] [--no-approval]",
            );
          }
          const requiresApproval = rest.includes("--no-approval") ? false : undefined;
          const title = parseFlagValue(rest, "--title") ?? null;
          const summary = parseFlagValue(rest, "--summary") ?? null;
          const sourceSkill = parseFlagValue(rest, "--source-skill") ?? null;
          const createdBy = parseFlagValue(rest, "--created-by") ?? "cued-cli";
          const dedupeKey = parseFlagValue(rest, "--dedupe-key") ?? null;
          if (
            await printOptionalDaemonResult(
              {
                command: "actions-propose",
                actionType,
                actionVersion,
                payload,
                title,
                summary,
                sourceSkill,
                createdBy,
                requiresApproval,
                dedupeKey,
              },
              "Daemon actions propose failed",
            )
          ) {
            return;
          }
          const registry = ActionDefinitionRegistry.load();
          const definition = registry.get(actionType, actionVersion);
          if (!definition) {
            throw new Error(`Unknown action definition: ${actionType}@${actionVersion}`);
          }
          const validation = registry.validatePayload(actionType, actionVersion, payload);
          if (!validation.ok) {
            throw new Error(validation.errors.join(" "));
          }
          const db = openCuedDatabase();
          try {
            printJson(
              db.createAction({
                actionType,
                actionVersion,
                title,
                summary,
                payload,
                sourceSkill: sourceSkill ?? definition.skillName,
                createdBy,
                requiresApproval: requiresApproval ?? definition.requiresApprovalDefault,
                dedupeKey,
              }),
            );
          } finally {
            db.close();
          }
          return;
        }
        case "list":
          {
            const status = parseActionStatusFlag(rest, "--status");
            const limit = parseIntegerFlag(rest, "--limit");
            if (
              await printOptionalDaemonResult(
                { command: "actions-list", status, limit },
                "Daemon actions list failed",
              )
            ) {
              return;
            }
            const db = openCuedDatabase();
            try {
              printJson(db.listActions({ status, limit }));
            } finally {
              db.close();
            }
          }
          return;
        case "show": {
          const actionId = rest[0];
          if (!actionId) {
            throw new Error("Usage: cued actions show <action-id>");
          }
          if (
            await printOptionalDaemonResult(
              { command: "actions-show", actionId },
              "Daemon actions show failed",
            )
          ) {
            return;
          }
          const db = openCuedDatabase();
          try {
            const action = db.getAction(actionId);
            if (!action) {
              throw new Error(`Action not found: ${actionId}`);
            }
            printJson({
              action,
              effects: db.listActionEffects(actionId),
            });
          } finally {
            db.close();
          }
          return;
        }
        case "approve": {
          const actionId = rest[0];
          if (!actionId) {
            throw new Error("Usage: cued actions approve <action-id> [--by ACTOR]");
          }
          const approvedBy = parseFlagValue(rest, "--by") ?? "user";
          if (
            await printOptionalDaemonResult(
              { command: "actions-approve", actionId, approvedBy },
              "Daemon actions approve failed",
            )
          ) {
            return;
          }
          const db = openCuedDatabase();
          try {
            printJson(db.approveAction(actionId, approvedBy));
          } finally {
            db.close();
          }
          return;
        }
        case "deny": {
          const actionId = rest[0];
          if (!actionId) {
            throw new Error("Usage: cued actions deny <action-id> [--by ACTOR]");
          }
          const deniedBy = parseFlagValue(rest, "--by") ?? "user";
          if (
            await printOptionalDaemonResult(
              { command: "actions-deny", actionId, deniedBy },
              "Daemon actions deny failed",
            )
          ) {
            return;
          }
          const db = openCuedDatabase();
          try {
            printJson(db.denyAction(actionId, deniedBy));
          } finally {
            db.close();
          }
          return;
        }
        case "execute": {
          const actionId = rest[0];
          if (!actionId) {
            throw new Error("Usage: cued actions execute <action-id> [--by ACTOR]");
          }
          const executedBy = parseFlagValue(rest, "--by") ?? "cued-cli";
          if (
            await printOptionalDaemonResult(
              { command: "actions-execute", actionId, executedBy },
              "Daemon actions execute failed",
            )
          ) {
            return;
          }
          const db = openCuedDatabase();
          try {
            const executed = db.executeApprovedAction(actionId, executedBy);
            printJson({
              ...executed,
              projection: actionRequiresProjectionRebuild(executed.action)
                ? rebuildProjectedState(db)
                : null,
            });
          } finally {
            db.close();
          }
          return;
        }
        case "run-approved": {
          const limit = parseIntegerFlag(rest, "--limit");
          const executedBy = parseFlagValue(rest, "--by") ?? "cued-cli";
          if (
            await printOptionalDaemonResult(
              { command: "actions-run-approved", limit, executedBy },
              "Daemon actions run-approved failed",
            )
          ) {
            return;
          }
          const db = openCuedDatabase();
          try {
            const approved = db.listApprovedPendingActions(limit ?? 25);
            const results = approved.map((action) => {
              try {
                const executed = db.executeApprovedAction(action.id, executedBy);
                if (actionRequiresProjectionRebuild(executed.action)) {
                  rebuildProjectedState(db);
                }
                return { actionId: action.id, ok: true, result: executed };
              } catch (error) {
                return {
                  actionId: action.id,
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                };
              }
            });
            printJson({
              attempted: results.length,
              succeeded: results.filter((result) => result.ok).length,
              failed: results.filter((result) => !result.ok).length,
              results,
            });
          } finally {
            db.close();
          }
          return;
        }
        default:
          throw new Error(
            "Usage: cued actions definitions | cued actions propose <type> --payload JSON [--version VERSION] [--title TEXT] [--summary TEXT] [--source-skill NAME] [--no-approval] | cued actions list [--status STATUS] [--limit N] | cued actions show <action-id> | cued actions approve <action-id> [--by ACTOR] | cued actions deny <action-id> [--by ACTOR] | cued actions execute <action-id> [--by ACTOR] | cued actions run-approved [--limit N] [--by ACTOR]",
          );
      }
    }
    case "status":
      try {
        response = await sendDaemonRequest({ command: "status" });
      } catch (error) {
        if (!isDaemonTimeout(error)) {
          throw error;
        }
        printJson(await buildLocalStatusFallback(error));
        return;
      }
      break;
    case "doctor":
      try {
        response = await sendDaemonRequest({ command: "doctor" });
      } catch (error) {
        if (!isDaemonTimeout(error)) {
          throw error;
        }
        printJson(await buildLocalDoctorFallback(error));
        return;
      }
      break;
    case "integrations":
      switch (subcommand) {
        case "list":
        case "status":
          response = await sendDaemonRequest({ command: "integrations-list" });
          if (isUnsupportedDaemonCommand(response)) {
            printJson(await handleLocalIntegrationCommand(subcommand, rest));
            return;
          }
          break;
        case "capabilities":
          printJson(await handleLocalIntegrationCommand(subcommand, rest));
          return;
        case "refresh":
          response = await sendDaemonRequest({ command: "integrations-refresh" });
          if (isUnsupportedDaemonCommand(response)) {
            printJson(await handleLocalIntegrationCommand(subcommand, rest));
            return;
          }
          break;
        case "connect":
          if (!rest[0]) {
            throw new Error("Usage: cued integrations connect <platform> [account]");
          }
          response = await sendDaemonRequest({
            command: "integrations-connect",
            platform: rest[0],
            accountKey: rest[1],
          });
          if (isUnsupportedDaemonCommand(response)) {
            printJson(await handleLocalIntegrationCommand(subcommand, rest));
            return;
          }
          break;
        case "disconnect":
          if (!rest[0]) {
            throw new Error("Usage: cued integrations disconnect <platform> [account]");
          }
          response = await sendDaemonRequest({
            command: "integrations-disconnect",
            platform: rest[0],
            accountKey: rest[1],
          });
          if (isUnsupportedDaemonCommand(response)) {
            printJson(await handleLocalIntegrationCommand(subcommand, rest));
            return;
          }
          break;
        case "remove":
          if (!rest[0]) {
            throw new Error("Usage: cued integrations remove <platform> [account]");
          }
          response = await sendDaemonRequest({
            command: "integrations-remove",
            platform: rest[0],
            accountKey: rest[1],
          });
          if (isUnsupportedDaemonCommand(response)) {
            printJson(await handleLocalIntegrationCommand(subcommand, rest));
            return;
          }
          break;
        case "enable":
          if (!rest[0]) {
            throw new Error("Usage: cued integrations enable <platform> [account]");
          }
          response = await sendDaemonRequest({
            command: "integrations-enable",
            platform: rest[0],
            accountKey: rest[1],
          });
          if (isUnsupportedDaemonCommand(response)) {
            printJson(await handleLocalIntegrationCommand(subcommand, rest));
            return;
          }
          break;
        case "disable":
          if (!rest[0]) {
            throw new Error("Usage: cued integrations disable <platform> [account]");
          }
          response = await sendDaemonRequest({
            command: "integrations-disable",
            platform: rest[0],
            accountKey: rest[1],
          });
          if (isUnsupportedDaemonCommand(response)) {
            printJson(await handleLocalIntegrationCommand(subcommand, rest));
            return;
          }
          break;
        default:
          throw new Error(IntegrationAuthService.usageText());
      }
      break;
    case "attachments":
      switch (subcommand) {
        case "list":
          response = await sendDaemonRequest({
            command: "attachments-list",
            messageId: parseFlagValue(rest, "--message"),
            conversationId: parseFlagValue(rest, "--conversation"),
            platform: parseFlagValue(rest, "--platform"),
            accountKey: parseFlagValue(rest, "--account"),
            limit: Number.parseInt(parseFlagValue(rest, "--limit") ?? "", 10) || undefined,
          });
          break;
        case "fetch":
          if (!rest[0]) {
            throw new Error(
              "Usage: cued attachments fetch <attachment-id> [--variant original] [--max-bytes N] [--allow-large] [--no-extract]",
            );
          }
          response = await sendDaemonRequest({
            command: "attachment-fetch",
            attachmentId: rest[0],
            variant: parseFlagValue(rest.slice(1), "--variant"),
            maxBytes:
              Number.parseInt(parseFlagValue(rest.slice(1), "--max-bytes") ?? "", 10) || undefined,
            allowLarge: rest.includes("--allow-large"),
            extractText: !rest.includes("--no-extract"),
          });
          break;
        case "search":
          if (!rest[0]) {
            throw new Error(
              "Usage: cued attachments search <query> [--conversation ID] [--platform PLATFORM] [--account ACCOUNT] [--limit N]",
            );
          }
          response = await sendDaemonRequest({
            command: "attachments-search",
            query: rest[0],
            conversationId: parseFlagValue(rest.slice(1), "--conversation"),
            platform: parseFlagValue(rest.slice(1), "--platform"),
            accountKey: parseFlagValue(rest.slice(1), "--account"),
            limit: Number.parseInt(parseFlagValue(rest.slice(1), "--limit") ?? "", 10) || undefined,
          });
          break;
        default:
          throw new Error(
            "Usage: cued attachments list [--message ID] [--conversation ID] [--platform PLATFORM] [--account ACCOUNT] [--limit N] | cued attachments fetch <attachment-id> [--variant original] [--max-bytes N] [--allow-large] [--no-extract] | cued attachments search <query> [--conversation ID] [--platform PLATFORM] [--account ACCOUNT] [--limit N]",
          );
      }
      break;
    case "sync":
      if (subcommand === "run") {
        response = await sendDaemonRequest({
          command: "sync-run",
          source: rest[0],
        });
        break;
      }
      if (subcommand === "resume") {
        response = await sendDaemonRequest({ command: "sync-resume" });
        break;
      }
      throw new Error("Usage: cued sync run [source] | cued sync resume");
    case "send":
      if (!subcommand || !rest[0]) {
        throw new Error("Usage: cued send <platform> <target> <text> [account]");
      }
      response = await sendDaemonRequest({
        command: "message-send",
        platform: subcommand,
        target: rest[0],
        text: rest[1] ?? "",
        accountKey: rest[2],
        threadId: rest[0],
      });
      break;
    case "contacts":
      if (subcommand === "memory" || subcommand === "memories") {
        const memoryCommand = rest[0];
        const args = rest.slice(1);
        assertNoLegacyQueueFlag(args);
        const db = openCuedDatabase();
        try {
          switch (memoryCommand) {
            case "add": {
              const contactId = args[0];
              const body = parseFlagValue(args, "--body") ?? parseFreeTextArgument(args, 1);
              if (!contactId || !body) {
                throw new Error(
                  "Usage: cued contacts memory add <contact-id> <memory> [--source SOURCE] [--confidence 0-100] [--evidence JSON] [--supersedes MEMORY_ID] [--execute]",
                );
              }
              const payload = {
                contactId,
                body,
                sourceKind: parseFlagValue(args, "--source") ?? "agent",
                evidence: parseJsonFlag(args, "--evidence"),
                confidence: parseIntegerFlag(args, "--confidence") ?? null,
                supersedesMemoryId: parseFlagValue(args, "--supersedes") ?? null,
              };
              const action = db.createAction({
                actionType: "contact.memory.add",
                payload,
                title: "Add contact memory",
                summary: body,
                sourceSkill: "cued",
                createdBy: parseFlagValue(args, "--created-by") ?? "cued-cli",
                requiresApproval: !args.includes("--execute"),
              });
              printJson(
                args.includes("--execute")
                  ? db.executeApprovedAction(action.id, parseFlagValue(args, "--by") ?? "cued-cli")
                  : action,
              );
              return;
            }
            case "list": {
              const contactId = args[0];
              if (!contactId) {
                throw new Error(
                  "Usage: cued contacts memory list <contact-id> [--limit N] [--include-stale]",
                );
              }
              printJson(
                db.listContactMemories({
                  contactId,
                  limit: parseIntegerFlag(args, "--limit"),
                  includeStale: args.includes("--include-stale"),
                }),
              );
              return;
            }
            case "stale": {
              const memoryId = args[0];
              if (!memoryId) {
                throw new Error("Usage: cued contacts memory stale <memory-id> [--execute]");
              }
              const action = db.createAction({
                actionType: "contact.memory.stale",
                payload: { memoryId },
                title: "Mark contact memory stale",
                sourceSkill: "cued",
                createdBy: parseFlagValue(args, "--created-by") ?? "cued-cli",
                requiresApproval: !args.includes("--execute"),
              });
              printJson(
                args.includes("--execute")
                  ? db.executeApprovedAction(action.id, parseFlagValue(args, "--by") ?? "cued-cli")
                  : action,
              );
              return;
            }
            default:
              throw new Error(
                "Usage: cued contacts memory add <contact-id> <memory> [--source SOURCE] [--confidence 0-100] [--evidence JSON] [--supersedes MEMORY_ID] [--execute] | cued contacts memory list <contact-id> [--limit N] [--include-stale] | cued contacts memory stale <memory-id> [--execute]",
              );
          }
        } finally {
          db.close();
        }
      }
      if (subcommand) {
        throw new Error(
          "Usage: cued contacts memory add|list|stale ... (use cued actions propose contact.merge for merges)",
        );
      }
      throw new Error("Usage: cued contacts memory add|list|stale ...");
    case "rebuild":
      response = await sendDaemonRequest({ command: "rebuild" });
      break;
    case "reset": {
      const sourceFlagIndex = [subcommand, ...rest].findIndex((value) => value === "--source");
      const source = sourceFlagIndex >= 0 ? [subcommand, ...rest][sourceFlagIndex + 1] : undefined;
      if (!source) {
        throw new Error("Usage: cued reset --source <source>");
      }
      response = await sendDaemonRequest({ command: "reset", source });
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }

  if (!response.ok) {
    throw new Error(response.error ?? "Daemon request failed");
  }

  printJson(response.result ?? null);
}

if (isInvokedDirectly()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
