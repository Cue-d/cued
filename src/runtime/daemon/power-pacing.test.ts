import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { continuationDelay, readHostPowerState } from "./power-pacing.js";

describe("power-aware historical continuation", () => {
  const history = {
    baseMs: 250,
    originTrigger: "scheduler",
    syncMode: "full",
    liveCoverage: true,
    continuation: { reason: "account_pagination" as const },
    power: { onBattery: true, lowPowerMode: false },
  };
  it("throttles automatic history while allowing eventual progress", () => {
    expect(continuationDelay(history)).toBe(60_000);
    expect(continuationDelay({ ...history, power: { onBattery: false, lowPowerMode: true } })).toBe(
      60_000,
    );
    expect(continuationDelay({ ...history, baseMs: 120_000 })).toBe(120_000);
  });
  it("preserves incremental, manual, auth, rate-limit, uncovered and unknown-power flows", () => {
    for (const override of [
      { syncMode: "incremental" },
      { originTrigger: "manual" },
      { originTrigger: "integration_authenticated" },
      { liveCoverage: false },
      { power: null },
      { power: { onBattery: false, lowPowerMode: false } },
      { continuation: { reason: "realtime_catchup" as const } },
      { continuation: { reason: "rate_limit_backoff" as const } },
    ])
      expect(continuationDelay({ ...history, ...override })).toBe(250);
  });
});

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readFileSync: vi.fn(),
}));

describe("host power snapshot", () => {
  afterEach(() => vi.restoreAllMocks());
  it("accepts an unchanged live host snapshot without requiring a polling heartbeat", () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ pid: 123, updatedAt: 1, onBattery: true, lowPowerMode: false }),
    );
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    expect(readHostPowerState()).toEqual({ onBattery: true, lowPowerMode: false });
    expect(kill).toHaveBeenCalledWith(123, 0);
  });
  it("fails open for a stopped host, malformed file or missing file", () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ pid: 123, onBattery: true, lowPowerMode: false }),
    );
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(readHostPowerState()).toBeNull();
    vi.mocked(readFileSync).mockReturnValue("{}");
    expect(readHostPowerState()).toBeNull();
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(readHostPowerState()).toBeNull();
  });
});
