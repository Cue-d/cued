import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import type { CuedDatabase } from "../../../db/database.js";
import type { AuthSessionState, Platform } from "../../../core/types/provider.js";
import { resolveMacOSNativeBinary } from "../../../runtime/native-binary.js";
import type { AuthSessionSummary } from "../state/types.js";

export interface NativeAuthResult {
  sessionId: string;
  platform: Platform;
  accountKey: string;
  state: Extract<AuthSessionState, "authenticated" | "failed" | "cancelled">;
  keychainService?: string | null;
  keychainAccount?: string | null;
  resultSummary?: Record<string, unknown> | null;
  errorSummary?: string | null;
}

export interface NativeAuthHandle {
  child: ChildProcess;
  completion: Promise<NativeAuthResult>;
}

function resolveNativeAuthBinary(): string {
  const binary = resolveMacOSNativeBinary(
    process.env.CUED_AUTH_NATIVE_BINARY ?? process.env.CUED_CONTACTS_NATIVE_BINARY,
  );
  if (!binary) {
    throw new Error("CuedNative binary not found; build native/macos/CuedNative first");
  }
  return binary;
}

function buildNativeAuthArgs(db: CuedDatabase, session: AuthSessionSummary): string[] {
  return [
    "auth",
    "open",
    "--platform",
    session.platform,
    "--account-key",
    session.accountKey,
    "--session-id",
    session.id,
    "--db-path",
    db.dbPath,
  ];
}

function parseNativeAuthOutput(stdout: string): NativeAuthResult {
  return JSON.parse(stdout) as NativeAuthResult;
}

export function startNativeAuthSession(
  db: CuedDatabase,
  session: AuthSessionSummary,
): NativeAuthHandle {
  const binary = resolveNativeAuthBinary();
  const args = buildNativeAuthArgs(db, session);
  const child = spawn(binary, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  const completion = new Promise<NativeAuthResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code === 0 && stdout.length > 0) {
        try {
          resolve(parseNativeAuthOutput(stdout));
          return;
        } catch (error) {
          reject(error);
          return;
        }
      }

      reject(
        new Error(stderr || stdout || `Native auth helper exited with code ${code ?? "unknown"}`),
      );
    });
  });

  return { child, completion };
}

export function runNativeAuthSessionSync(
  db: CuedDatabase,
  session: AuthSessionSummary,
): NativeAuthResult {
  const binary = resolveNativeAuthBinary();
  const stdout = execFileSync(binary, buildNativeAuthArgs(db, session), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return parseNativeAuthOutput(stdout);
}
