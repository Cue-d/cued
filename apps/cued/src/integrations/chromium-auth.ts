import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import type { CuedDatabase } from "../db/database.js";
import type { AuthSessionState, Platform } from "../types/provider.js";
import type { AuthSessionSummary, IntegrationStateSummary } from "./service.js";

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

function resolveWorkerEntrypoint(): string {
  return join(import.meta.dirname, "../workers/chromium-auth-worker.js");
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
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  const completion = new Promise<ChromiumAuthResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

      if (code === 0 && stdout.length > 0) {
        try {
          resolve(parseChromiumAuthOutput(stdout));
          return;
        } catch (error) {
          reject(error);
          return;
        }
      }

      reject(
        new Error(stderr || stdout || `Chromium auth helper exited with code ${code ?? "unknown"}`),
      );
    });
  });

  return { child, completion };
}

export function runChromiumAuthSessionSync(
  db: CuedDatabase,
  session: AuthSessionSummary,
  integration: IntegrationStateSummary,
): ChromiumAuthResult {
  const stdout = execFileSync(process.execPath, buildWorkerArgs(db, session, integration), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  return parseChromiumAuthOutput(stdout);
}
