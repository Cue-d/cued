import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { SLACK_DESKTOP_IMPORT_CONFIG } from "../../../core/config.js";
import type { CuedDatabase } from "../../../db/database.js";
import { storeSlackSession } from "./session-store.js";

declare const localStorage: {
  getItem(key: string): string | null;
};

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
  return SLACK_DESKTOP_IMPORT_CONFIG.appBinary;
}

function getSlackUserDataDir(): string {
  return SLACK_DESKTOP_IMPORT_CONFIG.userDataDir;
}

function getDebuggingPort(): number {
  return SLACK_DESKTOP_IMPORT_CONFIG.remoteDebuggingPort;
}

function getDesktopImportTimeoutMs(): number {
  return SLACK_DESKTOP_IMPORT_CONFIG.timeoutMs;
}

function hasAuthenticatedSlackIntegration(db: CuedDatabase): boolean {
  return db
    .listIntegrationStates()
    .some((row) => row.platform === "slack" && row.auth_state === "authenticated");
}

function isSlackInstalled(): boolean {
  return existsSync(getSlackAppBinary()) && existsSync(getSlackUserDataDir());
}

function canReachDebugger(port: number): boolean {
  try {
    execFileSync("curl", ["-sf", `http://127.0.0.1:${port}/json/version`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForDebugger(port: number, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (canReachDebugger(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Slack remote debugger on port ${port}`);
}

async function waitForDebuggerShutdown(port: number, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!canReachDebugger(port)) {
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
  options: { skipWhenAnyAuthenticated?: boolean; reviveUserRemoved?: boolean } = {},
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
  const debuggerAlreadyRunning = canReachDebugger(port);

  const attemptImport = async (launched: ChildProcess | null) => {
    try {
      await waitForDebugger(port, Math.min(timeoutMs, 15_000));
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
          context.cookies(["https://slack.com", "https://app.slack.com"]),
          timeoutMs,
          "Timed out reading Slack desktop cookies",
        );
        const dCookie = cookies.find(
          (cookie) => cookie.name === "d" && cookie.domain.includes("slack.com"),
        );
        if (!dCookie?.value) {
          throw new Error("Slack desktop app did not expose the required d cookie");
        }

        const sourcePath = getSlackUserDataDir();
        return teams.map((team) =>
          storeSlackSession(
            db,
            {
              accountKey: team.id,
              teamId: team.id,
              teamName: team.name,
              userId: team.user_id,
              token: team.token,
              cookie: dCookie.value,
              savedAt: Date.now(),
              sourcePath,
              importMethod: "slack-desktop-cdp",
            },
            {
              reviveUserRemoved: options.reviveUserRemoved,
            },
          ),
        );
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
    if (!debuggerAlreadyRunning) {
      throw error;
    }

    quitSlackDesktop();
    await waitForDebuggerShutdown(port, Math.min(timeoutMs, 5_000));
    return await attemptImport(launchSlackWithDebugger(port));
  }
}
