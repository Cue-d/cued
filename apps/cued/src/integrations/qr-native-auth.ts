import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { CuedDatabase } from "../db/database.js";
import type { AuthSessionState, Platform } from "../types/provider.js";
import type { AuthSessionSummary, IntegrationStateSummary } from "./service.js";

export interface QrNativeAuthResult {
  sessionId: string;
  platform: Platform;
  accountKey: string;
  state: Extract<AuthSessionState, "authenticated" | "failed" | "cancelled">;
  keychainService?: string | null;
  keychainAccount?: string | null;
  resultSummary?: Record<string, unknown> | null;
  errorSummary?: string | null;
}

export interface QrNativeAuthHandle {
  child: ChildProcess;
  completion: Promise<QrNativeAuthResult>;
}

function parseFakeResult(
  session: AuthSessionSummary,
  integration: IntegrationStateSummary,
): QrNativeAuthResult | null {
  const raw = process.env.CUED_FAKE_QR_AUTH_RESULT;
  if (!raw) {
    return null;
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    sessionId: session.id,
    platform: session.platform,
    accountKey: session.accountKey,
    state: parsed.state === "authenticated" ? "authenticated" : parsed.state === "cancelled" ? "cancelled" : "failed",
    keychainService: typeof parsed.keychainService === "string" ? parsed.keychainService : null,
    keychainAccount: typeof parsed.keychainAccount === "string" ? parsed.keychainAccount : session.accountKey,
    resultSummary: {
      runtime: "qr_native",
      integration: `${integration.platform}/${integration.accountKey}`,
      ...(typeof parsed.resultSummary === "object" && parsed.resultSummary
        ? (parsed.resultSummary as Record<string, unknown>)
        : {}),
    },
    errorSummary: typeof parsed.errorSummary === "string" ? parsed.errorSummary : null,
  };
}

export function startQrNativeAuthSession(
  _db: CuedDatabase,
  session: AuthSessionSummary,
  integration: IntegrationStateSummary,
): QrNativeAuthHandle {
  const fake = parseFakeResult(session, integration);
  if (fake) {
    const child = spawn("sh", ["-lc", "exit 0"], { stdio: "ignore" });
    return {
      child,
      completion: Promise.resolve(fake),
    };
  }

  const errorSummary = `QR auth runtime not implemented yet for ${integration.platform}; set CUED_FAKE_QR_AUTH_RESULT for tests`;
  const child = spawn("sh", ["-lc", "exit 1"], { stdio: "ignore" });
  return {
    child,
    completion: Promise.resolve({
      sessionId: session.id,
      platform: session.platform,
      accountKey: session.accountKey,
      state: "failed",
      keychainService: null,
      keychainAccount: null,
      resultSummary: {
        runtime: "qr_native",
        stub: true,
        ticket: randomUUID(),
      },
      errorSummary,
    }),
  };
}

export async function runQrNativeAuthSessionSync(
  db: CuedDatabase,
  session: AuthSessionSummary,
  integration: IntegrationStateSummary,
): Promise<QrNativeAuthResult> {
  const handle = startQrNativeAuthSession(db, session, integration);
  return handle.completion;
}
