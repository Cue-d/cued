import { randomBytes, randomUUID } from "node:crypto";
import { arch, release } from "node:os";
import { getCurrentAppVersion, getCurrentReleaseChannel } from "../core/app-metadata.js";
import type { CuedDatabase } from "../db/database.js";
import {
  buildTelemetryFingerprint,
  isDiagnosticTelemetryEvent,
  sanitizeTelemetryProperties,
  TELEMETRY_ENDPOINT,
  TELEMETRY_SETTING_KEYS,
  type TelemetryEnvelope,
  type TelemetryEventName,
  type TelemetryProperties,
} from "./events.js";

const TELEMETRY_TIMEOUT_MS = 2_000;
let sessionId: string | null = null;

function getSessionId(): string {
  sessionId ??= randomUUID();
  return sessionId;
}

function normalizeArch(): TelemetryEnvelope["arch"] {
  const value = arch();
  if (value === "arm64" || value === "x64") {
    return value;
  }
  return "unknown";
}

function normalizeOsVersion(): string {
  const match = release().match(/^(\d+(?:\.\d+){0,2})/);
  return match?.[1] ?? "0";
}

function getOrCreateSetting(db: CuedDatabase, key: string, createValue: () => string): string {
  const existing = db.getAppSetting(key)?.value;
  if (existing) {
    return existing;
  }
  const value = createValue();
  db.setAppSetting(key, value);
  return value;
}

export function isTelemetryEnabled(db: CuedDatabase): boolean {
  if (process.env.VITEST_WORKER_ID && !process.env.CUED_TELEMETRY_ENDPOINT) {
    return false;
  }
  return db.getAppSetting(TELEMETRY_SETTING_KEYS.enabled)?.value !== "0";
}

export function setTelemetryEnabled(db: CuedDatabase, enabled: boolean): void {
  db.setAppSetting(TELEMETRY_SETTING_KEYS.enabled, enabled ? "1" : "0");
}

export function getTelemetryStatus(db: CuedDatabase): {
  enabled: boolean;
  installId: string;
  endpoint: string;
} {
  return {
    enabled: isTelemetryEnabled(db),
    installId: getOrCreateSetting(db, TELEMETRY_SETTING_KEYS.installId, randomUUID),
    endpoint: TELEMETRY_ENDPOINT,
  };
}

export function getTelemetrySalt(db: CuedDatabase): string {
  return getOrCreateSetting(db, TELEMETRY_SETTING_KEYS.salt, () =>
    randomBytes(32).toString("base64url"),
  );
}

export function buildTelemetryEnvelope(
  db: CuedDatabase,
  eventName: TelemetryEventName,
  properties: TelemetryProperties = {},
): TelemetryEnvelope {
  getTelemetrySalt(db);

  const safeProperties = sanitizeTelemetryProperties(properties);
  if (isDiagnosticTelemetryEvent(eventName) && typeof safeProperties.fingerprint !== "string") {
    safeProperties.fingerprint = buildTelemetryFingerprint(eventName, safeProperties);
  }

  return {
    schema_version: 1,
    event_id: randomUUID(),
    event_name: eventName,
    occurred_at: new Date().toISOString(),
    install_id: getOrCreateSetting(db, TELEMETRY_SETTING_KEYS.installId, randomUUID),
    session_id: getSessionId(),
    source: "cued-desktop",
    app_version: getCurrentAppVersion(),
    release_channel: getCurrentReleaseChannel(),
    os_name: process.platform === "darwin" ? "macos" : "unknown",
    os_version: normalizeOsVersion(),
    arch: normalizeArch(),
    properties: safeProperties,
  };
}

export async function sendTelemetryEvent(
  db: CuedDatabase,
  eventName: TelemetryEventName,
  properties: TelemetryProperties = {},
  options: { fetchImpl?: typeof fetch } = {},
): Promise<{ sent: boolean; skipped: boolean; status?: number }> {
  if (!isTelemetryEnabled(db)) {
    return { sent: false, skipped: true };
  }

  const envelope = buildTelemetryEnvelope(db, eventName, properties);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
  const response = await fetchImpl(TELEMETRY_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: controller.signal,
    body: JSON.stringify(envelope),
  }).finally(() => clearTimeout(timeout));

  return {
    sent: response.ok,
    skipped: false,
    status: response.status,
  };
}
