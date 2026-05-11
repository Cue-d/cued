import { describe, expect, it } from "vitest";
import {
  buildSyncResumeTargets,
  effectiveIngestConcurrency,
  isDisconnectedSocketError,
  shouldProjectIngestRunInline,
  shouldSkipConnectedDiscordSchedulerSync,
  shouldThrottleIngestForInteractivity,
} from "./server.js";

describe("discord scheduler pacing", () => {
  const connectedStatus = {
    platform: "discord" as const,
    accountKey: "default",
    state: "connected" as const,
    userId: "u-self",
    username: "avery",
    connectedAt: 1,
    lastEventAt: 1,
    lastReconnectAt: null,
    reconnectAttempts: 0,
    lastSessionError: null,
  };

  it("skips scheduler syncs while discord realtime is connected", () => {
    expect(shouldSkipConnectedDiscordSchedulerSync("discord", "scheduler", connectedStatus)).toBe(
      true,
    );
  });

  it("does not skip non-scheduler or degraded discord runs", () => {
    expect(shouldSkipConnectedDiscordSchedulerSync("discord", "cli", connectedStatus)).toBe(false);
    expect(
      shouldSkipConnectedDiscordSchedulerSync("discord", "scheduler", {
        ...connectedStatus,
        state: "degraded",
      }),
    ).toBe(false);
  });

  it("does not affect other platforms", () => {
    expect(shouldSkipConnectedDiscordSchedulerSync("slack", "scheduler", connectedStatus)).toBe(
      false,
    );
  });
});

describe("ingest projection strategy", () => {
  it("defers discord sync projection so run completion is not coupled to projection", () => {
    expect(
      shouldProjectIngestRunInline({
        platform: "discord",
        realtimeProjectionEnabled: true,
        firstInsertedRowId: 1,
        lastInsertedRowId: 373,
      }),
    ).toBe(false);
  });

  it("keeps inline projection for non-discord sync batches when enabled", () => {
    expect(
      shouldProjectIngestRunInline({
        platform: "slack",
        realtimeProjectionEnabled: true,
        firstInsertedRowId: 1,
        lastInsertedRowId: 10,
      }),
    ).toBe(true);
    expect(
      shouldProjectIngestRunInline({
        platform: "slack",
        realtimeProjectionEnabled: false,
        firstInsertedRowId: 1,
        lastInsertedRowId: 10,
      }),
    ).toBe(false);
  });
});

describe("ingest interactivity throttling", () => {
  it("limits ingest concurrency while auth or recent GUI requests need priority", () => {
    expect(
      shouldThrottleIngestForInteractivity({
        activeAuthSessionCount: 1,
        activeIngestTargets: [],
        lastInteractiveRequestAt: 0,
        interactiveWindowMs: 30_000,
        backfillPressureUntil: 0,
        nowMs: 100_000,
      }),
    ).toBe(true);
    expect(
      shouldThrottleIngestForInteractivity({
        activeAuthSessionCount: 0,
        activeIngestTargets: [],
        lastInteractiveRequestAt: 90_000,
        interactiveWindowMs: 30_000,
        backfillPressureUntil: 0,
        nowMs: 100_000,
      }),
    ).toBe(true);
  });

  it("limits ingest concurrency during iMessage backfill pressure", () => {
    expect(
      shouldThrottleIngestForInteractivity({
        activeAuthSessionCount: 0,
        activeIngestTargets: [{ platform: "imessage" }],
        lastInteractiveRequestAt: 0,
        interactiveWindowMs: 30_000,
        backfillPressureUntil: 0,
        nowMs: 100_000,
      }),
    ).toBe(true);
    expect(
      shouldThrottleIngestForInteractivity({
        activeAuthSessionCount: 0,
        activeIngestTargets: [],
        lastInteractiveRequestAt: 0,
        interactiveWindowMs: 30_000,
        backfillPressureUntil: 120_000,
        nowMs: 100_000,
      }),
    ).toBe(true);
  });

  it("restores configured concurrency after pressure clears", () => {
    expect(
      shouldThrottleIngestForInteractivity({
        activeAuthSessionCount: 0,
        activeIngestTargets: [{ platform: "slack" }],
        lastInteractiveRequestAt: 0,
        interactiveWindowMs: 30_000,
        backfillPressureUntil: 0,
        nowMs: 100_000,
      }),
    ).toBe(false);
    expect(effectiveIngestConcurrency(4, true)).toBe(1);
    expect(effectiveIngestConcurrency(4, false)).toBe(4);
  });
});

describe("daemon socket errors", () => {
  it("classifies disconnected clients as non-fatal IPC errors", () => {
    for (const code of ["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED"]) {
      const error = new Error(code) as NodeJS.ErrnoException;
      error.code = code;
      expect(isDisconnectedSocketError(error)).toBe(true);
    }
  });

  it("does not hide unexpected socket errors", () => {
    const error = new Error("permission denied") as NodeJS.ErrnoException;
    error.code = "EACCES";
    expect(isDisconnectedSocketError(error)).toBe(false);
    expect(isDisconnectedSocketError("EPIPE")).toBe(false);
  });
});

describe("sync resume targets", () => {
  it("preserves account keys that contain colons", () => {
    expect(
      buildSyncResumeTargets({
        listEnabledSyncTargets: () => [
          {
            platform: "slack",
            account_key: "workspace:team",
          },
        ],
        listCheckpointTargets: () => [
          {
            platform: "gmail",
            account_key: "avery@example.com",
          },
        ],
      }),
    ).toEqual([
      {
        platform: "slack",
        accountKey: "workspace:team",
      },
      {
        platform: "gmail",
        accountKey: "avery@example.com",
      },
    ]);
  });
});
