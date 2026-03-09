#!/usr/bin/env node

import process from "node:process";
import { existsSync } from "node:fs";
import { CUED_DB_PATH, CUED_LOG_DIR, CUED_SOCKET_PATH, ensureCuedDirs } from "./config.js";
import { openCuedDatabase } from "./db/database.js";
import { buildDoctorReport } from "./diagnostics/doctor.js";
import { runDaemon } from "./daemon/server.js";
import { sendDaemonRequest } from "./client.js";
import {
  buildIntegrationStatus,
  connectIntegration,
  disconnectIntegration,
  getAuthSessionSummary,
  listIntegrationStates,
  listRequestableIntegrationPlatforms,
  completeAuthSession,
  getIntegrationSummary,
  markAuthSessionInProgress,
  refreshManagedIntegrationStates,
  setIntegrationEnabled,
} from "./integrations/service.js";
import { runAuthSessionSync } from "./integrations/auth-runtime.js";
import { doctorHooksConfig, emitHookEvent, HOOK_EVENT_NAMES, initHooksConfig, testHookEvent } from "./hooks/service.js";

function printHelp(): void {
  console.log(`cued

Usage:
  cued help
  cued daemon
  cued status
  cued doctor
  cued logs
  cued integrations list
  cued integrations status
  cued integrations refresh
  cued integrations connect <platform> [account]
  cued integrations request-access <platform> [account]
  cued integrations disconnect <platform> [account]
  cued integrations auth-status <session-id>
  cued integrations auth-cancel <session-id>
  cued integrations enable <platform> [account]
  cued integrations disable <platform> [account]
  cued integrations login <platform> [account]
  cued hooks init
  cued hooks doctor
  cued hooks test <event>
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

async function safeEmitHookEvent(event: typeof HOOK_EVENT_NAMES[number], payload: unknown): Promise<void> {
  try {
    await emitHookEvent(event, payload as Record<string, unknown>);
  } catch (error) {
    console.warn(`[cued hooks] ${event} failed: ${error instanceof Error ? error.message : String(error)}`);
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
        return refreshManagedIntegrationStates(db);
      case "connect":
      case "request-access":
      case "login":
      case "open": {
        if (!rest[0]) {
          throw new Error(`Usage: cued integrations ${subcommand} <platform> [account]`);
        }
        const requested = connectIntegration(db, rest[0], rest[1]);
        const running = markAuthSessionInProgress(db, requested.authSession.id, process.pid);
        try {
          const integration = getIntegrationSummary(db, requested.integration.platform, requested.integration.accountKey);
          const result = await runAuthSessionSync(db, running, integration);
          const completed = completeAuthSession(db, running.id, {
            state: result.state,
            keychainService: result.keychainService ?? null,
            keychainAccount: result.keychainAccount ?? null,
            resultSummary: result.resultSummary ?? null,
            errorSummary: result.errorSummary ?? null,
          });
          if (completed.integration.authState === "authenticated") {
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
      case "auth-status":
        if (!rest[0]) {
          throw new Error("Usage: cued integrations auth-status <session-id>");
        }
        return { authSession: getAuthSessionSummary(db, rest[0]) };
      case "auth-cancel":
        throw new Error("Auth cancellation requires the cued daemon to be running");
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
          `Usage: cued integrations list | status | refresh | connect <platform> [account] | disconnect <platform> [account] | auth-status <session-id> | auth-cancel <session-id> | enable <platform> [account] | disable <platform> [account] | login <platform> [account]\nRequestable platforms: ${listRequestableIntegrationPlatforms().join(", ")}`,
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

  if (command === "logs") {
    printJson({
      logDir: CUED_LOG_DIR,
      message: "Structured log persistence is not implemented yet",
    });
    return;
  }

  if ((command === "status" || command === "doctor") && !existsSync(CUED_SOCKET_PATH)) {
    const db = openCuedDatabase();
    printJson(
      command === "doctor"
        ? {
            ...buildDoctorReport(db),
            hooks: doctorHooksConfig(),
          }
        : {
            daemon: db.getDaemonState(),
            overview: db.getOverview(),
            checkpoints: db.listCheckpointSummary(),
            recentRuns: db.listRecentRuns(),
            integrations: listIntegrationStates(db),
            hooks: doctorHooksConfig(),
            socketRunning: false,
            migrationsApplied: true,
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
        if (!rest[0] || !HOOK_EVENT_NAMES.includes(rest[0] as typeof HOOK_EVENT_NAMES[number])) {
          throw new Error(`Usage: cued hooks test <event>\nEvents: ${HOOK_EVENT_NAMES.join(", ")}`);
        }
        printJson(await testHookEvent(rest[0] as typeof HOOK_EVENT_NAMES[number]));
        return;
      default:
        throw new Error(`Usage: cued hooks init | doctor | test <event>\nEvents: ${HOOK_EVENT_NAMES.join(", ")}`);
    }
    return;
  }

  let response;

  switch (command) {
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
        case "request-access":
          if (!rest[0]) {
            throw new Error(`Usage: cued integrations ${subcommand} <platform> [account]`);
          }
          response = await sendDaemonRequest({
            command: subcommand === "connect" ? "integrations-connect" : "integrations-request-access",
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
        case "auth-status":
          if (!rest[0]) {
            throw new Error("Usage: cued integrations auth-status <session-id>");
          }
          response = await sendDaemonRequest({
            command: "integrations-auth-status",
            sessionId: rest[0],
          });
          break;
        case "auth-cancel":
          if (!rest[0]) {
            throw new Error("Usage: cued integrations auth-cancel <session-id>");
          }
          response = await sendDaemonRequest({
            command: "integrations-auth-cancel",
            sessionId: rest[0],
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
        case "login":
        case "open":
          if (!rest[0]) {
            throw new Error("Usage: cued integrations login <platform> [account]");
          }
          response = await sendDaemonRequest({
            command: "integrations-connect",
            platform: rest[0],
            accountKey: rest[1],
          });
          break;
        default:
          throw new Error(
            `Usage: cued integrations list | status | refresh | connect <platform> [account] | disconnect <platform> [account] | auth-status <session-id> | auth-cancel <session-id> | enable <platform> [account] | disable <platform> [account] | login <platform> [account]\nRequestable platforms: ${listRequestableIntegrationPlatforms().join(", ")}`,
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
