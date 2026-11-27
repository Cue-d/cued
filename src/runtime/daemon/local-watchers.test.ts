import { describe, expect, it } from "vitest";
import {
  isNativeWatcherRunning,
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
