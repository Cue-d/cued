import type { CuedDatabase } from "../db/database.js";
import { sendTelemetryEvent } from "./client.js";
import type { TelemetryEventName, TelemetryProperties } from "./events.js";

const valuePattern = /[^a-z0-9_.:-]+/gi;

export function safeTelemetryValue(value: unknown, fallback = "unknown"): string {
  const normalized = String(value ?? fallback)
    .trim()
    .toLowerCase()
    .replace(valuePattern, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

export function durationBucket(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "unknown";
  }
  if (durationMs < 1_000) return "lt_1s";
  if (durationMs < 5_000) return "lt_5s";
  if (durationMs < 30_000) return "lt_30s";
  if (durationMs < 120_000) return "lt_2m";
  if (durationMs < 600_000) return "lt_10m";
  return "gte_10m";
}

export function errorTelemetryProperties(
  error: unknown,
  fallbackCode = "unknown_error",
): TelemetryProperties {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const errorKind =
    error instanceof Error ? error.name || error.constructor.name || "Error" : typeof error;
  const httpStatus = message.match(/\b(?:status|with|failed)[:\s()]+([45][0-9]{2})\b/i)?.[1];
  const exitCode = message.match(/\b(?:exit(?:ed)? with code|code)[:\s]+([0-9]{1,3})\b/i)?.[1];
  const timeout = /timeout|timed out|etimedout/i.test(message);
  const permission = /permission|denied|not authorized|eacces|eperm/i.test(message);
  const auth = /auth|unauthorized|forbidden|token|credential|keychain/i.test(message);
  const network = /network|fetch|econn|enotfound|socket|http|download/i.test(message);
  const errorCode =
    httpStatus != null
      ? `http_${httpStatus}`
      : exitCode != null
        ? `exit_${exitCode}`
        : permission
          ? "permission_denied"
          : auth
            ? "auth_failed"
            : timeout
              ? "timeout"
              : network
                ? "network_error"
                : fallbackCode;

  return {
    error_code: safeTelemetryValue(errorCode, fallbackCode),
    error_kind: safeTelemetryValue(errorKind, "error"),
    retryable: timeout || network || (httpStatus != null && Number(httpStatus) >= 500),
    ...(httpStatus ? { http_status: Number(httpStatus) } : {}),
    ...(exitCode ? { exit_code: Number(exitCode) } : {}),
  };
}

export async function sendTelemetryEventSafe(
  db: CuedDatabase,
  eventName: TelemetryEventName,
  properties: TelemetryProperties = {},
): Promise<void> {
  try {
    await sendTelemetryEvent(db, eventName, properties);
  } catch {
    // Telemetry must never affect product behavior.
  }
}
