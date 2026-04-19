import { describe, expect, it } from "vitest";
import { shouldSkipConnectedDiscordSchedulerSync } from "./server.js";

describe("discord scheduler pacing", () => {
  const connectedStatus = {
    platform: "discord" as const,
    accountKey: "default",
    state: "connected" as const,
    userId: "u-self",
    username: "theo",
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
