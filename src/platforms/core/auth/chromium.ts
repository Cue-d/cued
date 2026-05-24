import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getRuntimeConfigArgs } from "../../../core/config.js";
import type { AuthSessionState, Platform } from "../../../core/types/provider.js";
import type { CuedDatabase } from "../../../db/database.js";
import type { AuthSessionSummary, IntegrationStateSummary } from "../state/types.js";

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
    ...getRuntimeConfigArgs(),
  ];
}

function parseChromiumAuthOutput(stdout: string): ChromiumAuthResult {
  return JSON.parse(stdout) as ChromiumAuthResult;
}

export function startChromiumAuthSession(
  db: CuedDatabase,
  session: AuthSessionSummary,
  integration: IntegrationStateSummary,
): ChromiumAuthHandle {
  const child = spawn(process.execPath, buildWorkerArgs(db, session, integration), {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  const stdoutChunks: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.on("data", () => {});

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
