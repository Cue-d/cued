import { describe, expect, it } from "vitest";
import { shouldBootstrapLocalIntegrations, shouldRunLocalWatcher } from "./local-watchers.js";

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
