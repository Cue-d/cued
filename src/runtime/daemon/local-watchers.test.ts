import { describe, expect, it } from "vitest";
import {
  isNativeWatcherRunning,
  NATIVE_WATCHER_RESTART,
  nextNativeWatcherRestart,
  shouldBootstrapLocalIntegrations,
  shouldRunLocalWatcher,
} from "./local-watchers.js";

describe("shouldBootstrapLocalIntegrations", () => {
  it("keeps local bootstrap work off before onboarding is complete", () => {
    expect(shouldBootstrapLocalIntegrations({ onboardingCompletedVersion: null })).toBe(false);
    expect(shouldBootstrapLocalIntegrations({ onboardingCompletedVersion: "0.1.0" })).toBe(true);
  });
});

describe("shouldRunLocalWatcher", () => {
  it("keeps local watchers off before onboarding is complete", () => {
    expect(
      shouldRunLocalWatcher(
        { onboardingCompletedVersion: null },
        { enabled: 1, auth_state: "authorized" },
      ),
    ).toBe(false);
  });

  it("requires an enabled local integration", () => {
    expect(
      shouldRunLocalWatcher(
        { onboardingCompletedVersion: "0.1.0" },
        { enabled: 0, auth_state: "authorized" },
      ),
    ).toBe(false);
  });

  it("requires local authorization once onboarding is complete", () => {
    expect(
      shouldRunLocalWatcher(
        { onboardingCompletedVersion: "0.1.0" },
        { enabled: 1, auth_state: "authorized" },
      ),
    ).toBe(true);
    expect(
      shouldRunLocalWatcher(
        { onboardingCompletedVersion: "0.1.0" },
        { enabled: 1, auth_state: "authenticated" },
      ),
    ).toBe(true);
    expect(
      shouldRunLocalWatcher(
        { onboardingCompletedVersion: "0.1.0" },
        { enabled: 1, auth_state: "not_determined" },
      ),
    ).toBe(false);
  });
});

describe("native watcher liveness", () => {
  it("counts a running helper or a file watcher, not an exited or killed helper", () => {
    expect(isNativeWatcherRunning(undefined)).toBe(false);
    expect(isNativeWatcherRunning({ close: () => undefined })).toBe(true);
    const helper = { exitCode: null, signalCode: null, killed: false };
    expect(isNativeWatcherRunning(helper)).toBe(true);
    expect(isNativeWatcherRunning({ ...helper, exitCode: 1 })).toBe(false);
    expect(isNativeWatcherRunning({ ...helper, signalCode: "SIGTERM" as const })).toBe(false);
    expect(isNativeWatcherRunning({ ...helper, killed: true })).toBe(false);
  });
});

describe("nextNativeWatcherRestart", () => {
  it("backs off a watcher that keeps stopping, up to a cap", () => {
    let failures = 0;
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) {
      const next = nextNativeWatcherRestart(failures, 50);
      delays.push(next.delayMs);
      failures = next.failures;
    }
    expect(delays.slice(0, 5)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(Math.max(...delays)).toBe(NATIVE_WATCHER_RESTART.maxMs);
    expect(delays.at(-1)).toBe(NATIVE_WATCHER_RESTART.maxMs);
  });

  it("restarts promptly a watcher that had been running for a while", () => {
    expect(nextNativeWatcherRestart(9, NATIVE_WATCHER_RESTART.stableMs)).toEqual({
      delayMs: NATIVE_WATCHER_RESTART.initialMs,
      failures: 1,
    });
  });
});
