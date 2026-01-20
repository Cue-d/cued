import { describe, it, expect } from "vitest";
import {
  PLATFORM_CONFIG,
  getPlatformConfig,
  type ActionPlatform,
  type PlatformConfigItem,
} from "../platform";

describe("PLATFORM_CONFIG", () => {
  const platforms: ActionPlatform[] = ["imessage", "gmail", "slack", "linkedin"];

  it("contains all expected platform keys", () => {
    expect(Object.keys(PLATFORM_CONFIG)).toEqual(
      expect.arrayContaining(platforms)
    );
    expect(Object.keys(PLATFORM_CONFIG)).toHaveLength(platforms.length);
  });

  describe.each(platforms)("%s config", (platform) => {
    const config = PLATFORM_CONFIG[platform];

    it("has a non-empty label", () => {
      expect(config.label).toBeTruthy();
      expect(typeof config.label).toBe("string");
    });

    it("has a valid hex color", () => {
      expect(config.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    });

    it("has a valid textClass", () => {
      expect(config.textClass).toBeTruthy();
      expect(config.textClass).toMatch(/^text-/);
    });

    it("has a valid bgClass", () => {
      expect(config.bgClass).toBeTruthy();
      expect(config.bgClass).toMatch(/^bg-/);
    });

    it("has a single letter abbreviation", () => {
      expect(config.letter).toBeTruthy();
      expect(config.letter).toHaveLength(1);
    });
  });

  it("has correct values for iMessage", () => {
    expect(PLATFORM_CONFIG.imessage).toEqual({
      label: "iMessage",
      color: "#16a34a",
      textClass: "text-green-600",
      bgClass: "bg-green-500 text-white",
      letter: "i",
    });
  });

  it("has correct values for Gmail", () => {
    expect(PLATFORM_CONFIG.gmail).toEqual({
      label: "Gmail",
      color: "#dc2626",
      textClass: "text-red-600",
      bgClass: "bg-red-500 text-white",
      letter: "G",
    });
  });

  it("has correct values for Slack", () => {
    expect(PLATFORM_CONFIG.slack).toEqual({
      label: "Slack",
      color: "#9333ea",
      textClass: "text-purple-600",
      bgClass: "bg-purple-500 text-white",
      letter: "S",
    });
  });

  it("has correct values for LinkedIn", () => {
    expect(PLATFORM_CONFIG.linkedin).toEqual({
      label: "LinkedIn",
      color: "#0a66c2",
      textClass: "text-blue-600",
      bgClass: "bg-blue-600 text-white",
      letter: "L",
    });
  });
});

describe("getPlatformConfig", () => {
  it("returns config for valid platform keys", () => {
    expect(getPlatformConfig("imessage")).toBe(PLATFORM_CONFIG.imessage);
    expect(getPlatformConfig("gmail")).toBe(PLATFORM_CONFIG.gmail);
    expect(getPlatformConfig("slack")).toBe(PLATFORM_CONFIG.slack);
    expect(getPlatformConfig("linkedin")).toBe(PLATFORM_CONFIG.linkedin);
  });

  it("returns undefined for invalid platform key", () => {
    expect(getPlatformConfig("invalid")).toBeUndefined();
    expect(getPlatformConfig("email")).toBeUndefined();
    expect(getPlatformConfig("")).toBeUndefined();
  });

  it("handles case-sensitive lookups correctly", () => {
    expect(getPlatformConfig("iMessage")).toBeUndefined();
    expect(getPlatformConfig("GMAIL")).toBeUndefined();
    expect(getPlatformConfig("Slack")).toBeUndefined();
  });
});

describe("types", () => {
  it("ActionPlatform type includes all platforms", () => {
    // Type-level test: these should compile without error
    const imessage: ActionPlatform = "imessage";
    const gmail: ActionPlatform = "gmail";
    const slack: ActionPlatform = "slack";
    const linkedin: ActionPlatform = "linkedin";

    expect([imessage, gmail, slack, linkedin]).toHaveLength(4);
  });

  it("PlatformConfigItem has all required fields", () => {
    const config: PlatformConfigItem = {
      label: "Test",
      color: "#000000",
      textClass: "text-black",
      bgClass: "bg-black",
      letter: "T",
    };

    expect(config.label).toBe("Test");
    expect(config.color).toBe("#000000");
    expect(config.textClass).toBe("text-black");
    expect(config.bgClass).toBe("bg-black");
    expect(config.letter).toBe("T");
  });
});
