import { describe, expect, it } from "vitest";
import { getPlatformFeatureSupport } from "../platforms/core/types.js";
import { summarizePlatformCapability } from "./platform-capabilities.js";

describe("platform capability resolver", () => {
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
    expect(summarizePlatformCapability("discord", null, "linux")).toEqual(
      expect.objectContaining({
        availability: "available",
        supportsMultipleAccounts: false,
      }),
    );
  });

  it("exposes a shipped feature matrix for README-facing capabilities", () => {
    expect(getPlatformFeatureSupport("signal", "send")).toBe("yes");
    expect(getPlatformFeatureSupport("signal", "full_history_sync")).toBe("no");
    expect(getPlatformFeatureSupport("discord", "send")).toBe("yes");
    expect(getPlatformFeatureSupport("discord", "full_history_sync")).toBe("no");
    expect(getPlatformFeatureSupport("contacts", "send")).toBe("no");
    expect(getPlatformFeatureSupport("linkedin", "full_history_sync")).toBe("partial");
    expect(getPlatformFeatureSupport("linkedin", "read_receipts")).toBe("partial");
    expect(getPlatformFeatureSupport("imessage", "realtime_ingest")).toBe("yes");
  });
});
