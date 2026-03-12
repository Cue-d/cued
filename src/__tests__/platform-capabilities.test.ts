import { describe, expect, it } from "vitest";
import { summarizePlatformCapability } from "../platform-capabilities.js";

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
  });
});
