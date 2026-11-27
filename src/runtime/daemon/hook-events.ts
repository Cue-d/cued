import { createLogger } from "../../core/logging.js";
import type { openCuedDatabase } from "../../db/database.js";
import { getIntegrationSummary } from "../../platforms/core/state/status.js";
import { emitHookEvent } from "../hooks.js";

const hooksLogger = createLogger("hooks");

async function safeEmitHookEvent(
  event: "integration.authenticated" | "sync.completed" | "sync.failed" | "message.received",
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await emitHookEvent(event, payload);
  } catch (error) {
    hooksLogger.warn(`${event} failed`, error);
  }
}

async function emitAuthenticatedHook(
  db: ReturnType<typeof openCuedDatabase>,
  platform: string,
  accountKey: string,
): Promise<void> {
  await safeEmitHookEvent("integration.authenticated", {
    integration: getIntegrationSummary(db, platform, accountKey),
  });
}

export { emitAuthenticatedHook, safeEmitHookEvent };
