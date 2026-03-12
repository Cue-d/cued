#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getCurrentAppVersion, getCurrentReleaseChannel } from "./app-metadata.js";
import { sendDaemonRequest } from "./client.js";
import { CUED_DB_PATH, CUED_SOCKET_PATH, ensureCuedDirs } from "./config.js";
import { runDaemon } from "./daemon/server.js";
import { openCuedDatabase } from "./db/database.js";
import { buildDoctorReport } from "./diagnostics/doctor.js";
import {
  doctorHooksConfig,
  emitHookEvent,
  HOOK_EVENT_NAMES,
  initHooksConfig,
  testHookEvent,
} from "./hooks/service.js";
import { runAuthSessionSync } from "./integrations/auth-runtime.js";
import {
  buildIntegrationStatus,
  completeAuthSession,
  connectIntegration,
  disconnectIntegration,
  getIntegrationSummary,
  listIntegrationStates,
  listRequestableIntegrationPlatforms,
  markAuthSessionInProgress,
  refreshManagedIntegrationStates,
  setIntegrationEnabled,
} from "./integrations/service.js";
import { followLogs, getDaemonLogPath, parseLogsCommandArgs, readRecentLogLines } from "./logs.js";
import {
  getAppBundleInfo,
  getCLISymlinkStatus,
  getLaunchAgentStatus,
  installCLISymlink,
  installLaunchAgent,
  installMacOSApp,
  resolveInstalledAppPath,
  uninstallLaunchAgent,
} from "./macos/install.js";
import { resolveHostOS } from "./platform-capabilities.js";
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

function isInvokedDirectly(): boolean {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
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
  cued cli install|status
  cued onboarding complete|status
  cued launchd install|uninstall|status
  cued permissions doctor|request [--all|--contacts|--messages|--full-disk-access|--accessibility]
  cued integrations list
  cued integrations status
  cued integrations refresh
  cued integrations connect <platform> [account]
  cued integrations disconnect <platform> [account]
  cued integrations enable <platform> [account]
  cued integrations disable <platform> [account]
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
  try {
    switch (subcommand) {
      case "list":
      case "status":
        return buildIntegrationStatus(db);
      case "refresh":
        return await refreshManagedIntegrationStates(db);
      case "connect": {
        if (!rest[0]) {
          throw new Error("Usage: cued integrations connect <platform> [account]");
        }
        const requested = connectIntegration(db, rest[0], rest[1]);
        const running = markAuthSessionInProgress(db, requested.authSession.id, process.pid);
        try {
          const integration = getIntegrationSummary(
            db,
            requested.integration.platform,
            requested.integration.accountKey,
          );
          const result = await runAuthSessionSync(db, running, integration);
          const completed = completeAuthSession(db, running.id, {
            state: result.state,
            keychainService: result.keychainService ?? null,
            keychainAccount: result.keychainAccount ?? null,
            resultSummary: result.resultSummary ?? null,
            errorSummary: result.errorSummary ?? null,
          });
          if (completed.integration.authState === "authenticated") {
            if (
              !db.hasQueuedOrRunningRun(
                completed.integration.platform,
                completed.integration.accountKey,
              )
            ) {
              db.queueSyncRun({
                platform: completed.integration.platform,
                accountKey: completed.integration.accountKey,
                runType: "sync",
                trigger: "integration_authenticated",
                details: {
                  source: completed.integration.platform,
                  accountKey: completed.integration.accountKey,
                  trigger: "integration_authenticated",
                },
              });
            }
            await safeEmitHookEvent("integration.authenticated", completed);
          }
          return completed;
        } catch (error) {
          return completeAuthSession(db, running.id, {
            state: "failed",
            errorSummary: error instanceof Error ? error.message : String(error),
          });
        }
      }
      case "disconnect":
        if (!rest[0]) {
          throw new Error("Usage: cued integrations disconnect <platform> [account]");
        }
        return disconnectIntegration(db, rest[0], rest[1]);
      case "enable":
        if (!rest[0]) {
          throw new Error("Usage: cued integrations enable <platform> [account]");
        }
        return setIntegrationEnabled(db, rest[0], rest[1], true);
      case "disable":
        if (!rest[0]) {
          throw new Error("Usage: cued integrations disable <platform> [account]");
        }
        return setIntegrationEnabled(db, rest[0], rest[1], false);
      default:
        throw new Error(
          `Usage: cued integrations list | status | refresh | connect <platform> [account] | disconnect <platform> [account] | enable <platform> [account] | disable <platform> [account]\nRequestable platforms: ${listRequestableIntegrationPlatforms().join(", ")}`,
        );
    }
  } finally {
    db.close();
  }
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

  if ((command === "status" || command === "doctor") && !existsSync(CUED_SOCKET_PATH)) {
    const db = openCuedDatabase();
    printJson(
      command === "doctor"
        ? {
            app: getAppStatusMetadata(db),
            ...(await buildDoctorReport(db)),
            projection: db.getProjectionBacklog(),
            hooks: doctorHooksConfig(),
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
            socketRunning: false,
            dbPath: db.dbPath,
          },
    );
    db.close();
    return;
  }

  if (command === "integrations" && !existsSync(CUED_SOCKET_PATH)) {
    printJson(await handleLocalIntegrationCommand(subcommand, rest));
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
      const db = openCuedDatabase();
      try {
        switch (subcommand) {
          case "complete":
            db.markOnboardingCompleted(getCurrentAppVersion());
            printJson(db.getAppMetadata());
            return;
          case "status":
            printJson(db.getAppMetadata());
            return;
          default:
            throw new Error("Usage: cued onboarding complete | status");
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
        case "request": {
          const flags = rest.length > 0 ? rest : ["--all"];
          const scriptPath = resolvePermissionsScriptPath();
          printJson({
            app: getAppBundleInfo(),
            requested: flags,
            command: ["bash", scriptPath, ...flags],
          });
          execFileSync("bash", [scriptPath, ...flags], { stdio: "inherit" });
          return;
        }
        default:
          throw new Error(
            "Usage: cued permissions doctor | request [--all|--contacts|--messages|--full-disk-access|--accessibility]",
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
          break;
        case "refresh":
          response = await sendDaemonRequest({ command: "integrations-refresh" });
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
          break;
        default:
          throw new Error(
            `Usage: cued integrations list | status | refresh | connect <platform> [account] | disconnect <platform> [account] | enable <platform> [account] | disable <platform> [account]\nRequestable platforms: ${listRequestableIntegrationPlatforms().join(", ")}`,
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
