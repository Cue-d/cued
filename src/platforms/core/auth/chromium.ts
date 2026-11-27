import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AuthSessionState, Platform } from "../../../core/types/provider.js";
import type { CuedDatabase } from "../../../db/database.js";
import { parseSlackCaptureDiagnostic } from "../../slack/auth/capture-diagnostics.js";
import type { AuthSessionSummary, IntegrationStateSummary } from "../state/types.js";
import { type BrowserSetupProgress, parseBrowserSetupLine } from "./browser-setup.js";

export interface ChromiumAuthResult {
  sessionId: string;
  platform: Platform;
  accountKey: string;
  state: Extract<AuthSessionState, "authenticated" | "failed" | "cancelled">;
  keychainService?: string | null;
  keychainAccount?: string | null;
  resultSummary?: Record<string, unknown> | null;
  errorSummary?: string | null;
}

export interface ChromiumAuthHandle {
  child: ChildProcess;
  completion: Promise<ChromiumAuthResult>;
}

function buildChromiumProcessFailureResult(
  session: AuthSessionSummary,
  integration: IntegrationStateSummary,
): ChromiumAuthResult {
  return {
    sessionId: session.id,
    platform: session.platform,
    accountKey: session.accountKey,
    state: "failed",
    keychainService: null,
    keychainAccount: null,
    resultSummary: {
      provider: integration.platform,
      runtime: "chromium",
      errorCode: "browser_runtime_failed",
      stage: "browser_runtime",
    },
    errorSummary: `${integration.platform} browser auth runtime failed`,
  };
}

function resolveWorkerEntrypoint(): string {
  const jsEntrypoint = join(import.meta.dirname, "./chromium-worker.js");
  if (existsSync(jsEntrypoint)) {
    return jsEntrypoint;
  }

  const tsEntrypoint = join(import.meta.dirname, "./chromium-worker.ts");
  if (existsSync(tsEntrypoint)) {
    return tsEntrypoint;
  }

  return jsEntrypoint;
}

function buildWorkerArgs(
  _db: CuedDatabase,
  session: AuthSessionSummary,
  integration: IntegrationStateSummary,
): string[] {
  const metadata = integration.metadata ?? {};
  const profileDir =
    typeof metadata.browserProfileDir === "string" ? metadata.browserProfileDir : null;
  if (!profileDir) {
    throw new Error(
      `Chromium auth requires browserProfileDir metadata for ${integration.platform}/${integration.accountKey}`,
    );
  }

  return [
    ...process.execArgv,
    resolveWorkerEntrypoint(),
    "--platform",
    session.platform,
    "--account-key",
    session.accountKey,
    "--session-id",
    session.id,
    "--profile-dir",
    profileDir,
    "--launch-target",
    integration.launchTarget ?? "",
  ];
}

export interface ChromiumAuthHooks {
  /** Called after sign-in browser progress is recorded, so the app can be told to re-read. */
  onProgress?: () => void;
}

/** Setup updates for the same stage closer together than this are dropped by the daemon too. */
const BROWSER_SETUP_RECORD_INTERVAL_MS = 500;

/**
 * Keeps the sign-in session's browser setup progress (finding a browser, downloading one,
 * launching it) on the in-progress auth session, where status readers and the app see it. The
 * worker already sends at most one update a second per stage; this drops anything closer than
 * half a second as well, so a misbehaving worker cannot turn progress into a write per chunk.
 */
export function createBrowserSetupRecorder(
  db: CuedDatabase,
  session: AuthSessionSummary,
  hooks: ChromiumAuthHooks = {},
  now: () => number = Date.now,
): (progress: BrowserSetupProgress) => void {
  let lastStage: string | null = null;
  let lastRecordedAt = 0;
  return (progress) => {
    const at = now();
    if (progress.stage === lastStage && at - lastRecordedAt < BROWSER_SETUP_RECORD_INTERVAL_MS) {
      return;
    }
    lastStage = progress.stage;
    lastRecordedAt = at;
    try {
      if (db.getAuthSession(session.id)?.state !== "in_progress") return;
      db.updateAuthSessionState({
        id: session.id,
        state: "in_progress",
        resultSummary: {
          provider: session.platform,
          runtime: "chromium",
          stage: "browser_setup",
          browserSetup: progress,
        },
      });
    } catch {
      // Progress is informational; the sign-in continues without it.
      return;
    }
    hooks.onProgress?.();
  };
}

function parseChromiumAuthOutput(stdout: string): ChromiumAuthResult {
  return JSON.parse(stdout) as ChromiumAuthResult;
}

export function startChromiumAuthSession(
  db: CuedDatabase,
  session: AuthSessionSummary,
  integration: IntegrationStateSummary,
  hooks: ChromiumAuthHooks = {},
): ChromiumAuthHandle {
  const child = spawn(process.execPath, buildWorkerArgs(db, session, integration), {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  const stdoutChunks: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  const recordBrowserSetup = createBrowserSetupRecorder(db, session, hooks);
  createInterface({ input: child.stderr }).on("line", (line: string) => {
    const setup = parseBrowserSetupLine(line);
    if (setup) {
      recordBrowserSetup(setup);
      return;
    }
    const event = parseSlackCaptureDiagnostic(line);
    if (event && session.platform === "slack") {
      process.stderr.write(
        `${JSON.stringify({ event: "slack.auth.capture", sessionId: session.id, stage: event })}\n`,
      );
    }
  });

  const completion = new Promise<ChromiumAuthResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();

      if (code === 0 && stdout.length > 0) {
        try {
          resolve(parseChromiumAuthOutput(stdout));
          return;
        } catch (error) {
          reject(error);
          return;
        }
      }

      resolve(buildChromiumProcessFailureResult(session, integration));
    });
  });

  return { child, completion };
}

export function runChromiumAuthSessionSync(
  db: CuedDatabase,
  session: AuthSessionSummary,
  integration: IntegrationStateSummary,
): ChromiumAuthResult {
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, buildWorkerArgs(db, session, integration), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
  } catch {
    return buildChromiumProcessFailureResult(session, integration);
  }
  return parseChromiumAuthOutput(stdout);
}
