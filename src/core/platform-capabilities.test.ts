import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPlatformFeatureSupport } from "../platforms/core/types.js";
import { summarizePlatformCapability } from "./platform-capabilities.js";

const inspectSlackHelperMock = vi.fn();
const inspectWhatsAppHelperMock = vi.fn();

vi.mock("../platforms/slack/helper/binary.js", () => ({
  inspectSlackHelper: () => inspectSlackHelperMock(),
}));

vi.mock("../platforms/whatsapp/helper/binary.js", () => ({
  inspectWhatsAppHelper: () => inspectWhatsAppHelperMock(),
}));

describe("platform capability resolver", () => {
  beforeEach(() => {
    inspectSlackHelperMock.mockReset();
    inspectSlackHelperMock.mockReturnValue({
      helperPath: "/tmp/cued-slack-helper",
      version: "0.1.0",
      protocolVersion: 1,
      versionSupported: true,
    });
    inspectWhatsAppHelperMock.mockReset();
    inspectWhatsAppHelperMock.mockReturnValue({
      helperPath: "/tmp/cued-whatsapp-helper",
      version: "0.1.0",
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

  it("keeps Signal setup placeholders connectable before helper diagnostics exist", () => {
    expect(
      summarizePlatformCapability(
        "signal",
        {
          platform: "signal",
          authState: "missing",
          metadata: {
            helper: "cued-signal-cli",
          },
        },
        "macos",
      ),
    ).toEqual(
      expect.objectContaining({
        availability: "available",
        helperRequirements: ["signal_cli"],
      }),
    );
  });

  it("marks Signal as requiring a helper when diagnostics show it is unavailable", () => {
    expect(
      summarizePlatformCapability(
        "signal",
        {
          platform: "signal",
          authState: "missing",
          metadata: {
            signalCliPath: null,
            signalVersionSupported: false,
          },
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

  it("keeps WhatsApp connectable when the bundled helper is present", () => {
    expect(
      summarizePlatformCapability(
        "whatsapp",
        {
          platform: "whatsapp",
          authState: "missing",
          metadata: null,
        },
        "macos",
      ),
    ).toEqual(
      expect.objectContaining({
        availability: "available",
        helperRequirements: ["whatsapp_helper"],
      }),
    );
    expect(inspectWhatsAppHelperMock).toHaveBeenCalledTimes(1);
  });

  it("marks WhatsApp as requiring a helper when the helper is unavailable", () => {
    inspectWhatsAppHelperMock.mockReturnValue({
      helperPath: null,
      version: null,
    });

    expect(
      summarizePlatformCapability(
        "whatsapp",
        {
          platform: "whatsapp",
          authState: "missing",
          metadata: null,
        },
        "macos",
      ),
    ).toEqual(
      expect.objectContaining({
        availability: "requires_helper",
        helperRequirements: ["whatsapp_helper"],
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
    expect(inspectSlackHelperMock).not.toHaveBeenCalled();
  });

  it("does not probe the Slack helper for unauthenticated setup rows", () => {
    expect(
      summarizePlatformCapability(
        "slack",
        {
          platform: "slack",
          authState: "missing",
          metadata: null,
        },
        "macos",
      ),
    ).toEqual(
      expect.objectContaining({
        availability: "available",
        helperRequirements: ["slack_helper"],
      }),
    );
    expect(inspectSlackHelperMock).not.toHaveBeenCalled();
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
    expect(inspectSlackHelperMock).toHaveBeenCalledTimes(1);
  });

  it("uses cached Slack helper metadata before probing the helper binary", () => {
    expect(
      summarizePlatformCapability(
        "slack",
        {
          platform: "slack",
          authState: "authenticated",
          metadata: {
            slackHelperPath: "/tmp/cued-slack-helper",
            slackHelperVersionSupported: true,
          },
        },
        "macos",
      ),
    ).toEqual(
      expect.objectContaining({
        availability: "available",
        helperRequirements: ["slack_helper"],
      }),
    );
    expect(inspectSlackHelperMock).not.toHaveBeenCalled();
  });

  it("exposes a shipped feature matrix for README-facing capabilities", () => {
    expect(getPlatformFeatureSupport("signal", "full_history_sync")).toBe("no");
    expect(getPlatformFeatureSupport("discord", "full_history_sync")).toBe("no");
    expect(getPlatformFeatureSupport("linkedin", "full_history_sync")).toBe("partial");
    expect(getPlatformFeatureSupport("linkedin", "read_receipts")).toBe("partial");
    expect(getPlatformFeatureSupport("imessage", "realtime_ingest")).toBe("yes");
  });
});
