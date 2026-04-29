import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import type { CuedDatabase } from "../../../db/database.js";
import { isUserRemovedIntegrationRow } from "../../core/state/status.js";
import { storeSlackSession } from "./session-store.js";

declare const localStorage: {
  getItem(key: string): string | null;
};

const DEFAULT_SLACK_APP_BINARY = "/Applications/Slack.app/Contents/MacOS/Slack";
const DEFAULT_SLACK_USER_DATA_DIR = join(
  process.env.HOME ?? "",
  "Library",
  "Application Support",
  "Slack",
);
const DEFAULT_DEBUGGING_PORT = 9222;

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

function hasAuthenticatedSlackIntegration(db: CuedDatabase): boolean {
  return db
    .listIntegrationStates()
    .some((row) => row.platform === "slack" && row.auth_state === "authenticated");
}

function hasUserRemovedSlackIntegration(db: CuedDatabase): boolean {
  return db
    .listIntegrationStates()
    .some((row) => row.platform === "slack" && isUserRemovedIntegrationRow(row));
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

function launchSlackWithDebugger(port: number): ChildProcess {
  return spawn(getSlackAppBinary(), [`--remote-debugging-port=${port}`], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
}

function parseLocalConfig(raw: string): SlackDesktopLocalConfig {
  return JSON.parse(raw) as SlackDesktopLocalConfig;
}

export async function importSlackDesktopAuth(db: CuedDatabase): Promise<
  Array<{
    platform: "slack";
    accountKey: string;
    sourcePath: string;
    imported: boolean;
  }>
> {
  if (
    !isSlackInstalled() ||
    hasAuthenticatedSlackIntegration(db) ||
    hasUserRemovedSlackIntegration(db)
  ) {
    return [];
  }

  const port = getDebuggingPort();
  const debuggerAlreadyRunning = canReachDebugger(port);
  const launched = debuggerAlreadyRunning ? null : launchSlackWithDebugger(port);

  try {
    await waitForDebugger(port);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    try {
      const context = browser.contexts()[0];
      if (!context) {
        throw new Error("Slack CDP connection did not expose a browser context");
      }

      const page = context.pages().find((candidate) => candidate.url().includes("app.slack.com"));
      if (!page) {
        throw new Error("Slack app did not expose an authenticated app.slack.com page");
      }

      const rawLocalConfig = await page.evaluate(() => localStorage.getItem("localConfig_v2"));
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

      const cookies = await context.cookies(["https://slack.com", "https://app.slack.com"]);
      const dCookie = cookies.find(
        (cookie) => cookie.name === "d" && cookie.domain.includes("slack.com"),
      );
      if (!dCookie?.value) {
        throw new Error("Slack desktop app did not expose the required d cookie");
      }

      const sourcePath = getSlackUserDataDir();
      return teams.map((team) =>
        storeSlackSession(db, {
          accountKey: team.id,
          teamId: team.id,
          teamName: team.name,
          userId: team.user_id,
          token: team.token,
          cookie: dCookie.value,
          savedAt: Date.now(),
          sourcePath,
          importMethod: "slack-desktop-cdp",
        }),
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
}
