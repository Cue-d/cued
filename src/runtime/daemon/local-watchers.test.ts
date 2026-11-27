import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWatcherSyncTrigger,
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

describe("createWatcherSyncTrigger", () => {
  const timing = { debounceMs: 1_500, maxWaitMs: 5_000, busyRetryWindowMs: 10_000 };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("requests one sync once changes pause", () => {
    const trigger = createWatcherSyncTrigger(timing);
    const requests: number[] = [];
    const request = () => {
      requests.push(Date.now());
      return "taken" as const;
    };
    const start = Date.now();
    trigger("imessage:local", request);
    vi.advanceTimersByTime(1_000);
    trigger("imessage:local", request);
    vi.advanceTimersByTime(1_499);
    expect(requests).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(requests).toEqual([start + 2_500]);
    vi.advanceTimersByTime(60_000);
    expect(requests).toHaveLength(1);
  });

  it("does not let steady changes postpone the sync past the longest wait", () => {
    const trigger = createWatcherSyncTrigger(timing);
    const requests: number[] = [];
    const request = () => {
      requests.push(Date.now());
      return "taken" as const;
    };
    const start = Date.now();
    for (let elapsed = 0; elapsed < 12_000; elapsed += 500) {
      trigger("imessage:local", request);
      vi.advanceTimersByTime(500);
    }
    vi.advanceTimersByTime(1_500);
    expect(requests).toEqual([start + 5_000, start + 10_000, start + 13_000]);
  });

  it("asks again while a sync that may have missed the change is running", () => {
    const trigger = createWatcherSyncTrigger(timing);
    let busyUntil = Date.now() + 4_000;
    const answers: string[] = [];
    const request = () => {
      const answer = Date.now() < busyUntil ? "busy" : "taken";
      answers.push(answer);
      return answer;
    };
    trigger("imessage:local", request);
    vi.advanceTimersByTime(60_000);
    expect(answers).toEqual(["busy", "busy", "taken"]);

    // A sync that never ends is not asked about for ever.
    answers.length = 0;
    busyUntil = Number.POSITIVE_INFINITY;
    trigger("imessage:local", request);
    vi.advanceTimersByTime(60_000);
    expect(answers).toHaveLength(7);
    expect(new Set(answers)).toEqual(new Set(["busy"]));
  });

  it("keeps sources apart", () => {
    const trigger = createWatcherSyncTrigger(timing);
    const requested: string[] = [];
    for (const key of ["imessage:local", "contacts:local"]) {
      trigger(key, () => {
        requested.push(key);
        return "taken";
      });
    }
    vi.advanceTimersByTime(1_500);
    expect(requested).toEqual(["imessage:local", "contacts:local"]);
  });
});
