import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { chromium } from "playwright";
import type { CuedDatabase } from "../../../db/database.js";
import { storeSlackSession } from "./session-store.js";
import { SlackSessionVerificationError, verifySlackSession } from "./verify-session.js";

declare const localStorage: {
  getItem(key: string): string | null;
};

const DEFAULT_SLACK_APP_BINARY = "/Applications/Slack.app/Contents/MacOS/Slack";
const DEFAULT_SLACK_USER_DATA_DIR = join(homedir(), "Library", "Application Support", "Slack");
const DEFAULT_DEBUGGING_PORT = 9222;
const DEFAULT_SLACK_DESKTOP_IMPORT_TIMEOUT_MS = 20_000;
const DEBUGGER_PROBE_TIMEOUT_MS = 2_000;
// A second Slack launch hands off to the running instance and exits. Give a freshly launched
// one this long to expose its debugger after its launcher process is gone before giving up.
const LAUNCH_EXIT_GRACE_MS = 1_500;

interface SlackDesktopTeamConfig {
  id: string;
  name: string;
  token: string;
  user_id: string;
}

interface SlackDesktopLocalConfig {
  teams?: Record<string, SlackDesktopTeamConfig>;
}

function getSlackAppBinary(): string {
  return process.env.CUED_SLACK_APP_BINARY ?? DEFAULT_SLACK_APP_BINARY;
}

function getSlackUserDataDir(): string {
  return process.env.CUED_SLACK_USER_DATA_DIR ?? DEFAULT_SLACK_USER_DATA_DIR;
}

function getDebuggingPort(): number {
  const configured = Number(process.env.CUED_SLACK_REMOTE_DEBUGGING_PORT ?? DEFAULT_DEBUGGING_PORT);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DEBUGGING_PORT;
}

function getDesktopImportTimeoutMs(): number {
  const configured = Number(
    process.env.CUED_SLACK_DESKTOP_IMPORT_TIMEOUT_MS ?? DEFAULT_SLACK_DESKTOP_IMPORT_TIMEOUT_MS,
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_SLACK_DESKTOP_IMPORT_TIMEOUT_MS;
}

function hasAuthenticatedSlackIntegration(db: CuedDatabase): boolean {
  return db
    .listIntegrationStates()
    .some((row) => row.platform === "slack" && row.auth_state === "authenticated");
}

function isSlackInstalled(): boolean {
  return existsSync(getSlackAppBinary()) && existsSync(getSlackUserDataDir());
}

/** Runs a command without blocking the caller; resolves to whether it exited successfully. */
function succeeds(file: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: DEBUGGER_PROBE_TIMEOUT_MS }, (error) => resolve(!error));
  });
}

function canReachDebugger(port: number): Promise<boolean> {
  return succeeds("curl", ["-sf", `http://127.0.0.1:${port}/json/version`]);
}

function isSlackDesktopRunning(): Promise<boolean> {
  return succeeds("pgrep", ["-x", basename(getSlackAppBinary())]);
}

async function waitForDebugger(
  port: number,
  timeoutMs = 15_000,
  launched: ChildProcess | null = null,
): Promise<void> {
  const startedAt = Date.now();
  let launcherExitedAt: number | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    if (await canReachDebugger(port)) {
      return;
    }
    if (launched && (launched.exitCode != null || launched.signalCode != null)) {
      launcherExitedAt ??= Date.now();
      if (Date.now() - launcherExitedAt >= LAUNCH_EXIT_GRACE_MS) {
        throw new Error(
          `Slack exited without exposing a remote debugger on port ${port}; it is probably already running`,
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Slack remote debugger on port ${port}`);
}

async function waitForDebuggerShutdown(port: number, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await canReachDebugger(port))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Slack remote debugger on port ${port} stayed reachable after quitting Slack; not reconnecting to a stale desktop session.`,
  );
}

function launchSlackWithDebugger(port: number): ChildProcess {
  return spawn(getSlackAppBinary(), [`--remote-debugging-port=${port}`], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
}

function quitSlackDesktop(): void {
  try {
    execFileSync("osascript", ["-e", 'tell application "Slack" to quit'], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    try {
      execFileSync("pkill", ["-x", "Slack"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      // Best-effort recovery for a wedged desktop app.
    }
  }
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, summary: string): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(summary)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function parseLocalConfig(raw: string): SlackDesktopLocalConfig {
  return JSON.parse(raw) as SlackDesktopLocalConfig;
}

export async function importSlackDesktopAuth(
  db: CuedDatabase,
  options: {
    skipWhenAnyAuthenticated?: boolean;
    reviveUserRemoved?: boolean;
    reconnectInvalidated?: boolean;
  } = {},
): Promise<
  Array<{
    platform: "slack";
    accountKey: string;
    sourcePath: string;
    imported: boolean;
  }>
> {
  const skipWhenAnyAuthenticated = options.skipWhenAnyAuthenticated ?? true;
  if (!isSlackInstalled() || (skipWhenAnyAuthenticated && hasAuthenticatedSlackIntegration(db))) {
    return [];
  }

  const port = getDebuggingPort();
  const timeoutMs = getDesktopImportTimeoutMs();
  const debuggerAlreadyRunning = await canReachDebugger(port);
  if (!debuggerAlreadyRunning && (await isSlackDesktopRunning())) {
    // Slack only exposes a debugger when it is launched with one. Launching again just focuses
    // the running app, so the old behaviour was to wait out the full timeout here every time
    // Slack was open: on daemon start, on status refresh, and before every Slack connect.
    // Restarting someone's Slack to read its session is not ours to do unprompted; report
    // nothing imported and let the caller fall through to browser sign-in immediately.
    return [];
  }

  const attemptImport = async (launched: ChildProcess | null) => {
    try {
      await waitForDebugger(port, Math.min(timeoutMs, 15_000), launched);
      const browser = await withTimeout(
        chromium.connectOverCDP(`http://127.0.0.1:${port}`),
        timeoutMs,
        `Timed out connecting to Slack remote debugger on port ${port}`,
      );
      try {
        const context = browser.contexts()[0];
        if (!context) {
          throw new Error("Slack CDP connection did not expose a browser context");
        }

        const page = context.pages().find((candidate) => candidate.url().includes("app.slack.com"));
        if (!page) {
          throw new Error("Slack app did not expose an authenticated app.slack.com page");
        }

        const rawLocalConfig = await withTimeout(
          page.evaluate(() => localStorage.getItem("localConfig_v2")),
          timeoutMs,
          "Timed out reading Slack desktop auth state",
        );
        if (!rawLocalConfig) {
          throw new Error("Slack localConfig_v2 was not available in desktop app storage");
        }

        const parsed = parseLocalConfig(rawLocalConfig);
        const teams = Object.values(parsed.teams ?? {}).filter(
          (team) =>
            typeof team?.id === "string" &&
            typeof team?.name === "string" &&
            typeof team?.token === "string" &&
            team.token.startsWith("xoxc-") &&
            typeof team?.user_id === "string",
        );
        if (teams.length === 0) {
          throw new Error("No authenticated Slack teams were present in localConfig_v2");
        }

        const cookies = await withTimeout(
          context.cookies(["https://slack.com", "https://app.slack.com", page.url()]),
          timeoutMs,
          "Timed out reading Slack desktop cookies",
        );
        const sourcePath = getSlackUserDataDir();
        const imported = [];
        for (const team of teams) {
          const verified = await verifySlackSession(team.token, team.id, cookies);
          if (!verified) {
            imported.push({
              platform: "slack" as const,
              accountKey: team.id,
              sourcePath,
              imported: false,
            });
            continue;
          }
          imported.push(
            storeSlackSession(
              db,
              {
                accountKey: verified.teamId,
                teamId: verified.teamId,
                teamName: verified.teamName,
                userId: verified.userId,
                token: team.token,
                cookie: verified.cookie,
                savedAt: Date.now(),
                sourcePath,
                importMethod: "slack-desktop-cdp",
              },
              {
                reviveUserRemoved: options.reviveUserRemoved,
                reconnectInvalidated: options.reconnectInvalidated,
              },
            ),
          );
        }
        return imported;
      } finally {
        await browser.close();
      }
    } finally {
      if (launched) {
        try {
          process.kill(-launched.pid!);
        } catch {
          // Best-effort cleanup for the temporary Slack instance.
        }
      }
    }
  };

  const firstLaunch = debuggerAlreadyRunning ? null : launchSlackWithDebugger(port);
  try {
    return await attemptImport(firstLaunch);
  } catch (error) {
    if (!debuggerAlreadyRunning || error instanceof SlackSessionVerificationError) {
      throw error;
    }

    quitSlackDesktop();
    await waitForDebuggerShutdown(port, Math.min(timeoutMs, 5_000));
    return await attemptImport(launchSlackWithDebugger(port));
  }
}
