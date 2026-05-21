import { createHash } from "node:crypto";

export const TELEMETRY_ENDPOINT =
  process.env.CUED_TELEMETRY_ENDPOINT ?? "https://cued.so/api/telemetry/events";

export const TELEMETRY_SETTING_KEYS = {
  enabled: "telemetry_enabled",
  installId: "telemetry_install_id",
  salt: "telemetry_salt",
} as const;

export const telemetryEventNames = [
  "app_launched",
  "onboarding_started",
  "onboarding_completed",
  "diagnostics_opt_in_changed",
  "permission_requested",
  "permission_result",
  "integration_setup_started",
  "integration_setup_completed",
  "integration_setup_failed",
  "sync_started",
  "sync_completed",
  "sync_failed",
  "doctor_started",
  "doctor_completed",
  "doctor_check_failed",
  "daemon_started",
  "daemon_crashed",
  "daemon_request_failed",
  "helper_started",
  "helper_failed",
  "db_open_failed",
  "db_migration_started",
  "db_migration_failed",
  "update_check_started",
  "update_check_failed",
  "update_available",
  "update_install_started",
  "update_install_completed",
  "update_install_failed",
  "rollback_started",
  "rollback_completed",
  "rollback_failed",
] as const;

export type TelemetryEventName = (typeof telemetryEventNames)[number];

export type TelemetryProperties = Record<string, string | number | boolean | null | undefined>;

export interface TelemetryEnvelope {
  schema_version: 1;
  event_id: string;
  event_name: TelemetryEventName;
  occurred_at: string;
  install_id: string;
  session_id: string;
  source: "cued-desktop";
  app_version: string;
  release_channel: string;
  os_name: "macos" | "unknown";
  os_version: string;
  arch: "arm64" | "x64" | "unknown";
  properties: Record<string, string | number | boolean>;
}

const safePropertyKeys = new Set([
  "arch",
  "attempt_bucket",
  "component",
  "current_version",
  "doctor_check_id",
  "duration_bucket",
  "enabled",
  "error_code",
  "error_kind",
  "exit_code",
  "fingerprint",
  "from_schema_version",
  "http_status",
  "helper_kind",
  "install_age_bucket",
  "job_kind",
  "operation",
  "permission_kind",
  "phase",
  "platform",
  "release_channel",
  "remediation_id",
  "request_kind",
  "restart_count_bucket",
  "retryable",
  "run_id",
  "run_type",
  "result",
  "stage",
  "subsystem",
  "target_version",
  "test_event",
  "to_schema_version",
  "trigger",
  "update_stage",
]);

const deniedKeyPattern =
  /(account|address|attachment|body|call|contact|content|conversation|cookie|count|email|file|handle|host|message|name|path|phone|query|row|sql|subject|text|token|url|user|workspace)/i;
const safeValuePattern = /^[a-z0-9_.:-]{1,80}$/i;
const versionPattern = /^[0-9A-Za-z.+-]{1,48}$/;
const fingerprintPattern = /^[0-9a-f]{16,128}$/i;

export function sanitizeTelemetryProperties(
  properties: TelemetryProperties = {},
): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(properties)) {
    if (!safePropertyKeys.has(key) || deniedKeyPattern.test(key) || value == null) {
      continue;
    }
    if (typeof value === "boolean") {
      safe[key] = value;
      continue;
    }
    if (typeof value === "number") {
      if (Number.isFinite(value) && Math.abs(value) <= 1_000_000) {
        safe[key] = value;
      }
      continue;
    }
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    const pattern =
      key === "fingerprint"
        ? fingerprintPattern
        : key.endsWith("_version") || key === "current_version" || key === "target_version"
          ? versionPattern
          : safeValuePattern;
    if (pattern.test(trimmed)) {
      safe[key] = trimmed;
    }
  }

  return safe;
}

function stringProperty(
  properties: Record<string, string | number | boolean>,
  key: string,
): string {
  const value = properties[key];
  return typeof value === "string" ? value.toLowerCase() : "none";
}

export function isDiagnosticTelemetryEvent(eventName: TelemetryEventName): boolean {
  return (
    eventName.endsWith("_failed") ||
    eventName.endsWith("_crashed") ||
    eventName === "doctor_check_failed"
  );
}

export function buildTelemetryFingerprint(
  eventName: TelemetryEventName,
  properties: Record<string, string | number | boolean>,
): string {
  const parts = [
    eventName,
    stringProperty(properties, "subsystem"),
    stringProperty(properties, "component"),
    stringProperty(properties, "operation"),
    stringProperty(properties, "phase"),
    stringProperty(properties, "platform"),
    stringProperty(properties, "run_type"),
    stringProperty(properties, "job_kind"),
    stringProperty(properties, "helper_kind"),
    stringProperty(properties, "doctor_check_id"),
    stringProperty(properties, "request_kind"),
    stringProperty(properties, "update_stage"),
    stringProperty(properties, "stage"),
    stringProperty(properties, "error_code"),
    stringProperty(properties, "error_kind"),
    stringProperty(properties, "http_status"),
    stringProperty(properties, "exit_code"),
  ];

  return createHash("sha256").update(parts.join("\0")).digest("hex");
}
