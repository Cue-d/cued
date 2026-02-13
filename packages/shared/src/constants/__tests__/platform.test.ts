import { describe, it, expect } from "vitest";
import {
  PLATFORM_CONFIG,
  getPlatformConfig,
  type ActionPlatform,
} from "../platform";

describe("PLATFORM_CONFIG", () => {
  const platforms: ActionPlatform[] = [
    "imessage",
    "slack",
    "linkedin",
    "twitter",
    "signal",
    "whatsapp",
  ];

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
});

describe("getPlatformConfig", () => {
  it("returns config for valid platform keys", () => {
    expect(getPlatformConfig("imessage")).toBe(PLATFORM_CONFIG.imessage);
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
