#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { sendDaemonRequest } from "./client.js";
import { getCurrentAppVersion, getCurrentReleaseChannel } from "./core/app-metadata.js";
import { CUED_DB_PATH, CUED_SOCKET_PATH, ensureCuedDirs } from "./core/config.js";
import { resolveHostOS } from "./core/platform-capabilities.js";
import { openCuedDatabase, openCuedDatabaseReadOnly } from "./db/database.js";
import {
  disableLoginItem,
  enableLoginItem,
  getAppBundleInfo,
  getCLISymlinkStatus,
  getLoginItemStatus,
  getLaunchAgentStatus,
  installCLISymlink,
  installLaunchAgent,
  installMacOSApp,
  resolveInstalledAppPath,
  uninstallLaunchAgent,
} from "./macos/install.js";
import { IntegrationAuthService } from "./platforms/core/auth/service.js";
import { getIntegrationSummary, listIntegrationStates } from "./platforms/core/state/status.js";
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
import {
  checkForUpdates,
  getUpdateStatus,
  installAvailableUpdate,
  runUpdatePreflight,
} from "./runtime/updater/service.js";
import { runSetupTUI } from "./setup.js";

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
  cued onboarding complete|snapshot|status [--refresh-managed]
  cued launchd install|uninstall|status
  cued permissions doctor|status|request [--all|--contacts|--messages|--full-disk-access]
  cued integrations list
  cued integrations status
  cued integrations refresh
  cued integrations connect <platform> [account]
  cued integrations disconnect <platform> [account]
  cued integrations remove <platform> [account]
  cued integrations enable <platform> [account]
  cued integrations disable <platform> [account]
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
  cued merge contact <left> <right>
  cued split contact <contact>

Paths:
  db: ${CUED_DB_PATH}
  socket: ${CUED_SOCKET_PATH}
`);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const index = args.findIndex((value) => value === flag);
  return index >= 0 ? args[index + 1] : undefined;
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

async function handleLocalIntegrationCommand(
  subcommand: string | undefined,
  rest: string[],
): Promise<unknown> {
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
        return service.connectLocally(rest[0], rest[1], {
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

  if ((command === "status" || command === "doctor") && !existsSync(CUED_SOCKET_PATH)) {
    const db = openCuedDatabase();
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
            projection: db.getProjectionBacklog(),
            checkpoints: db.listCheckpointSummary(),
            recentRuns: db.listRecentRuns(),
            integrations: listIntegrationStates(db),
            hooks: doctorHooksConfig(),
            update: getUpdateStatus(db),
            socketRunning: false,
            dbPath: db.dbPath,
          },
    );
    db.close();
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
      const db =
        subcommand === "snapshot" && !refreshManaged
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
              }),
            );
            return;
          case "status":
            printJson(db.getAppMetadata());
            return;
          default:
            throw new Error(
              "Usage: cued onboarding complete | snapshot [--refresh-managed] | status",
            );
        }
      } finally {
        db.close();
      }
    }
    case "launchd":
      switch (subcommand) {
        case "install":
          printJson(installLaunchAgent());
          return;
        case "uninstall":
          printJson(uninstallLaunchAgent());
          return;
        case "status":
          printJson(getLaunchAgentStatus());
          return;
        default:
          throw new Error("Usage: cued launchd install | uninstall | status");
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
    case "status":
      response = await sendDaemonRequest({ command: "status" });
      break;
    case "doctor":
      response = await sendDaemonRequest({ command: "doctor" });
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
    case "merge":
      if (subcommand !== "contact" || !rest[0] || !rest[1]) {
        throw new Error("Usage: cued merge contact <left> <right>");
      }
      response = await sendDaemonRequest({
        command: "merge-contact",
        leftContactId: rest[0],
        rightContactId: rest[1],
      });
      break;
    case "split":
      if (subcommand !== "contact" || !rest[0]) {
        throw new Error("Usage: cued split contact <contact>");
      }
      response = await sendDaemonRequest({
        command: "split-contact",
        contactId: rest[0],
      });
      break;
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
