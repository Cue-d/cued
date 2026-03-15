import type { ChildProcess } from "node:child_process";
import type { AuthSessionState, Platform } from "../../../core/types/provider.js";
import type { CuedDatabase } from "../../../db/database.js";
import type { AuthSessionSummary, IntegrationStateSummary } from "../state/types.js";
import { runChromiumAuthSessionSync, startChromiumAuthSession } from "./chromium.js";
import { runNativeAuthSessionSync, startNativeAuthSession } from "./native.js";
import { runQrNativeAuthSessionSync, startQrNativeAuthSession } from "./qr-native.js";

export interface AuthRuntimeResult {
  sessionId: string;
  platform: Platform;
  accountKey: string;
  state: Extract<AuthSessionState, "authenticated" | "failed" | "cancelled">;
  keychainService?: string | null;
  keychainAccount?: string | null;
  resultSummary?: Record<string, unknown> | null;
  errorSummary?: string | null;
}

export interface AuthRuntimeHandle {
  child: ChildProcess;
  completion: Promise<AuthRuntimeResult>;
}

export function startAuthSession(
  db: CuedDatabase,
  session: AuthSessionSummary,
  integration: IntegrationStateSummary,
): AuthRuntimeHandle {
  switch (integration.runtimeKind) {
    case "chromium":
      return startChromiumAuthSession(db, session, integration);
    case "qr_native":
      return startQrNativeAuthSession(db, session, integration);
    case "native":
      return startNativeAuthSession(db, session);
    default:
      throw new Error(`Unsupported auth runtime: ${integration.runtimeKind}`);
  }
}

export async function runAuthSessionSync(
  db: CuedDatabase,
  session: AuthSessionSummary,
  integration: IntegrationStateSummary,
): Promise<AuthRuntimeResult> {
  switch (integration.runtimeKind) {
    case "chromium":
      return runChromiumAuthSessionSync(db, session, integration);
    case "qr_native":
      return runQrNativeAuthSessionSync(db, session, integration);
    case "native":
      return runNativeAuthSessionSync(db, session);
    default:
      throw new Error(`Unsupported auth runtime: ${integration.runtimeKind}`);
  }
}
