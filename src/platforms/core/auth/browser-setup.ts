import { safeParseJsonRecord } from "../../../db/codecs.js";
import type { CuedDatabase } from "../../../db/database.js";
import { isUserRemovedIntegrationRow } from "../state/status.js";
import type { Platform } from "../types.js";
import type { BrowserDownloadProgress } from "./managed-browser.js";

/**
 * What a sign-in window is waiting on before it opens. Normally it goes straight from
 * `finding` to `launching` to `ready` in well under a second; on a Mac with no supported browser
 * it spends minutes in `downloading` while Cued fetches its own Chromium.
 */
export type BrowserSetupStage =
  | "finding"
  | "downloading"
  | "verifying"
  | "extracting"
  | "launching"
  | "ready"
  | "failed";

export interface BrowserSetupProgress {
  stage: BrowserSetupStage;
  receivedBytes: number | null;
  totalBytes: number | null;
  error: string | null;
}

/** The sign-in browser state the app shows, from the latest sign-in session. */
export interface SignInBrowserState extends BrowserSetupProgress {
  sessionId: string;
  platform: Platform;
  accountKey: string;
  updatedAt: number;
}

const BROWSER_SETUP_STAGES = new Set<string>([
  "finding",
  "downloading",
  "verifying",
  "extracting",
  "launching",
  "ready",
  "failed",
]);
const CHROMIUM_SIGN_IN_PLATFORMS = new Set<string>(["slack", "linkedin", "discord"]);
/** A failed download stays on screen this long, or until another sign-in starts. */
export const SIGN_IN_BROWSER_FAILURE_VISIBLE_MS = 30 * 60_000;
const LINE_PREFIX = '{"browserSetup"';

export function browserSetupFromDownload(progress: BrowserDownloadProgress): BrowserSetupProgress {
  return {
    stage: progress.stage === "installed" ? "launching" : progress.stage,
    receivedBytes: progress.stage === "downloading" ? progress.receivedBytes : null,
    totalBytes: progress.stage === "downloading" ? progress.totalBytes : null,
    error: null,
  };
}

const MB = 1024 * 1024;

/** Plain text for a person, such as "Downloading sign-in browser, 42 of 150 MB". */
export function describeBrowserSetup(progress: BrowserSetupProgress): string {
  switch (progress.stage) {
    case "finding":
      return "Looking for a browser for the sign-in window";
    case "downloading": {
      const received = Math.floor((progress.receivedBytes ?? 0) / MB);
      return progress.totalBytes
        ? `Downloading sign-in browser, ${received} of ${Math.ceil(progress.totalBytes / MB)} MB`
        : `Downloading sign-in browser, ${received} MB`;
    }
    case "verifying":
      return "Checking the downloaded sign-in browser";
    case "extracting":
      return "Installing the sign-in browser";
    case "launching":
      return "Opening the sign-in window";
    case "ready":
      return "Sign-in window is open";
    case "failed":
      return progress.error ?? "The sign-in browser could not be set up";
  }
}

/**
 * Reports setup progress at most once per `intervalMs` while the stage stays the same. A new
 * stage always goes out, so the last word (verifying, launching, failed) is never dropped.
 */
export function createBrowserSetupReporter(
  write: (progress: BrowserSetupProgress) => void,
  options: { intervalMs?: number; now?: () => number } = {},
): (progress: BrowserSetupProgress) => void {
  const intervalMs = options.intervalMs ?? 1_000;
  const now = options.now ?? Date.now;
  let lastStage: BrowserSetupStage | null = null;
  let lastReportAt = 0;
  return (progress) => {
    const at = now();
    if (progress.stage === lastStage && at - lastReportAt < intervalMs) return;
    lastStage = progress.stage;
    lastReportAt = at;
    write(progress);
  };
}

export function formatBrowserSetupLine(progress: BrowserSetupProgress): string {
  return JSON.stringify({ browserSetup: progress });
}

function readBytes(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function readBrowserSetup(value: unknown): BrowserSetupProgress | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.stage !== "string" || !BROWSER_SETUP_STAGES.has(record.stage)) return null;
  return {
    stage: record.stage as BrowserSetupStage,
    receivedBytes: readBytes(record.receivedBytes),
    totalBytes: readBytes(record.totalBytes),
    error: typeof record.error === "string" ? record.error.slice(0, 500) : null,
  };
}

/** The worker writes one of these per line on stderr; anything else is not setup progress. */
export function parseBrowserSetupLine(line: string): BrowserSetupProgress | null {
  if (!line.startsWith(LINE_PREFIX)) return null;
  try {
    return readBrowserSetup((JSON.parse(line) as { browserSetup?: unknown }).browserSetup);
  } catch {
    return null;
  }
}

/**
 * The state to show for the most recent sign-in, or null when there is nothing to show: no
 * browser sign-in is running, its window is already open, or it ended some other way.
 */
export function readSignInBrowserState(
  db: CuedDatabase,
  now = Date.now(),
): SignInBrowserState | null {
  const [latest] = db.listAuthSessions(1);
  if (!latest || !CHROMIUM_SIGN_IN_PLATFORMS.has(latest.platform)) return null;
  const summary = safeParseJsonRecord(
    latest.result_summary_json,
    "auth_sessions.result_summary_json",
  );
  const setup = readBrowserSetup(summary?.browserSetup);
  const base = {
    sessionId: latest.id,
    platform: latest.platform,
    accountKey: latest.account_key,
    updatedAt: latest.updated_at,
  };
  if (latest.state === "requested" || latest.state === "in_progress") {
    if (setup?.stage === "ready" || setup?.stage === "failed") return null;
    return {
      ...base,
      ...(setup ?? { stage: "finding", receivedBytes: null, totalBytes: null, error: null }),
    };
  }
  if (
    latest.state === "failed" &&
    setup?.stage === "failed" &&
    now - (latest.finished_at ?? latest.updated_at) < SIGN_IN_BROWSER_FAILURE_VISIBLE_MS
  ) {
    // The account was removed since: there is nothing left to try again.
    const integration = db.getIntegrationState(latest.platform, latest.account_key);
    if (integration && isUserRemovedIntegrationRow(integration)) return null;
    return { ...base, ...setup, error: setup.error ?? latest.error_summary };
  }
  return null;
}
