import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openCuedDatabase } from "../db/database.js";
import { buildTelemetryEnvelope, sendTelemetryEvent, setTelemetryEnabled } from "./client.js";
import { durationBucket, errorTelemetryProperties } from "./context.js";
import { buildTelemetryFingerprint, sanitizeTelemetryProperties } from "./events.js";

const tempDirs: string[] = [];

function openTempDb() {
  const dir = mkdtempSync(join(tmpdir(), "cued-telemetry-"));
  tempDirs.push(dir);
  return openCuedDatabase(join(dir, "local.db"));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("telemetry client", () => {
  it("drops PII-shaped and count-shaped properties", () => {
    expect(
      sanitizeTelemetryProperties({
        platform: "imessage",
        error_code: "permission_denied",
        message_count: 10,
        email: "a@example.com",
        local_path: "/Users/theo/.cued/local.db",
      }),
    ).toEqual({
      platform: "imessage",
      error_code: "permission_denied",
    });
  });

  it("generates and persists an anonymous install id", () => {
    const db = openTempDb();
    try {
      const first = buildTelemetryEnvelope(db, "app_launched").install_id;
      const second = buildTelemetryEnvelope(db, "app_launched").install_id;
      expect(first).toBe(second);
      expect(first).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      db.close();
    }
  });

  it("builds stable diagnostic fingerprints from sanitized enum fields", () => {
    const base = {
      platform: "imessage",
      subsystem: "sync",
      error_code: "permission_denied",
      message_text: "do not include me",
    };
    const safe = sanitizeTelemetryProperties(base);

    expect(buildTelemetryFingerprint("sync_failed", safe)).toBe(
      buildTelemetryFingerprint("sync_failed", safe),
    );
    expect(buildTelemetryFingerprint("sync_failed", safe)).not.toBe(
      buildTelemetryFingerprint("sync_failed", { ...safe, error_code: "timeout" }),
    );
    expect(safe).not.toHaveProperty("message_text");
  });

  it("adds a fingerprint to diagnostic envelopes without one", () => {
    const db = openTempDb();
    try {
      const envelope = buildTelemetryEnvelope(db, "sync_failed", {
        platform: "imessage",
        subsystem: "sync",
        error_code: "permission_denied",
      });
      expect(envelope.properties.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      db.close();
    }
  });

  it("keeps traceable failure context without raw error text", () => {
    const safe = sanitizeTelemetryProperties({
      component: "sync",
      operation: "ingest",
      stage: "adapter",
      run_id: "44444444-4444-4444-8444-444444444444",
      run_type: "sync",
      duration_bucket: durationBucket(1_200),
      ...errorTelemetryProperties(new Error("Request failed with 503 for /private/path")),
      message_text: "do not include this",
      local_path: "/Users/example/.cued/local.db",
    });

    expect(safe).toMatchObject({
      component: "sync",
      operation: "ingest",
      stage: "adapter",
      run_id: "44444444-4444-4444-8444-444444444444",
      run_type: "sync",
      duration_bucket: "lt_5s",
      error_code: "http_503",
      http_status: 503,
      retryable: true,
    });
    expect(safe).not.toHaveProperty("message_text");
    expect(safe).not.toHaveProperty("local_path");
  });

  it("skips sends when telemetry is disabled", async () => {
    const db = openTempDb();
    try {
      setTelemetryEnabled(db, false);
      const result = await sendTelemetryEvent(
        db,
        "app_launched",
        {},
        {
          fetchImpl: (() => {
            throw new Error("should_not_fetch");
          }) as typeof fetch,
        },
      );
      expect(result).toEqual({ sent: false, skipped: true });
    } finally {
      db.close();
    }
  });

  it("skips sends under Vitest unless an endpoint is explicitly configured", async () => {
    const db = openTempDb();
    try {
      const result = await sendTelemetryEvent(
        db,
        "app_launched",
        {},
        {
          fetchImpl: (() => {
            throw new Error("should_not_fetch");
          }) as typeof fetch,
        },
      );
      expect(result).toEqual({ sent: false, skipped: true });
    } finally {
      db.close();
    }
  });
});
