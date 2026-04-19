import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPlatformFeatureSupport } from "../platforms/core/types.js";
import { summarizePlatformCapability } from "./platform-capabilities.js";

const inspectSlackHelperMock = vi.fn();

vi.mock("../platforms/slack/helper/binary.js", () => ({
  inspectSlackHelper: () => inspectSlackHelperMock(),
}));

describe("platform capability resolver", () => {
  beforeEach(() => {
    inspectSlackHelperMock.mockReturnValue({
      helperPath: "/tmp/cued-slack-helper",
      version: "0.1.0",
      protocolVersion: 1,
      versionSupported: true,
    });
  });

  it("marks macOS-only connectors unsupported on non-macOS hosts", () => {
    expect(summarizePlatformCapability("imessage", null, "windows")).toEqual(
      expect.objectContaining({
        availability: "unsupported",
        onboardingVisible: true,
        supportsMultipleAccounts: false,
      }),
    );
  });

  it("marks permissions-required connectors correctly on macOS", () => {
    expect(
      summarizePlatformCapability(
        "contacts",
        {
          platform: "contacts",
          authState: "not_determined",
        },
        "macos",
      ),
    ).toEqual(
      expect.objectContaining({
        availability: "requires_permission",
        supportsMultipleAccounts: false,
      }),
    );
  });

  it("marks helper-driven connectors as requiring helpers when missing", () => {
    expect(
      summarizePlatformCapability(
        "signal",
        {
          platform: "signal",
          authState: "missing",
        },
        "macos",
      ),
    ).toEqual(
      expect.objectContaining({
        availability: "requires_helper",
        supportsMultipleAccounts: false,
      }),
    );
  });

  it("keeps browser connectors available across supported hosts", () => {
    expect(summarizePlatformCapability("slack", null, "linux")).toEqual(
      expect.objectContaining({
        availability: "available",
        supportsMultipleAccounts: true,
      }),
    );
  });

  it("marks Slack as helper-gated when the bundled helper is unavailable", () => {
    inspectSlackHelperMock.mockReturnValue({
      helperPath: null,
      version: null,
      protocolVersion: null,
      versionSupported: false,
    });

    expect(
      summarizePlatformCapability(
        "slack",
        {
          platform: "slack",
          authState: "authenticated",
        },
        "macos",
      ),
    ).toEqual(
      expect.objectContaining({
        availability: "requires_helper",
        helperRequirements: ["slack_helper"],
      }),
    );
  });

  it("exposes a shipped feature matrix for README-facing capabilities", () => {
    expect(getPlatformFeatureSupport("signal", "send")).toBe("yes");
    expect(getPlatformFeatureSupport("signal", "full_history_sync")).toBe("no");
    expect(getPlatformFeatureSupport("contacts", "send")).toBe("no");
    expect(getPlatformFeatureSupport("linkedin", "full_history_sync")).toBe("partial");
    expect(getPlatformFeatureSupport("linkedin", "read_receipts")).toBe("partial");
    expect(getPlatformFeatureSupport("imessage", "realtime_ingest")).toBe("yes");
  });
});
