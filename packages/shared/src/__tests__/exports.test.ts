import { describe, it, expect } from "vitest";
import * as shared from "../index";

describe("@prm/shared exports", () => {
  describe("phone utilities", () => {
    it("exports normalizePhone", () => {
      expect(shared.normalizePhone).toBeTypeOf("function");
    });

    it("exports getPhoneVariants", () => {
      expect(shared.getPhoneVariants).toBeTypeOf("function");
    });

    it("exports phonesMatch", () => {
      expect(shared.phonesMatch).toBeTypeOf("function");
    });

    it("exports formatPhoneNumber", () => {
      expect(shared.formatPhoneNumber).toBeTypeOf("function");
    });
  });

  describe("general utilities", () => {
    it("exports getInitials", () => {
      expect(shared.getInitials).toBeTypeOf("function");
    });
  });

  describe("time utilities", () => {
    it("exports formatTime", () => {
      expect(shared.formatTime).toBeTypeOf("function");
    });

    it("exports formatRelativeTime", () => {
      expect(shared.formatRelativeTime).toBeTypeOf("function");
    });

    it("exports formatTimestamp", () => {
      expect(shared.formatTimestamp).toBeTypeOf("function");
    });
  });

  describe("platform constants", () => {
    it("exports PLATFORM_CONFIG", () => {
      expect(shared.PLATFORM_CONFIG).toBeTypeOf("object");
      expect(shared.PLATFORM_CONFIG).toHaveProperty("imessage");
      expect(shared.PLATFORM_CONFIG).toHaveProperty("gmail");
      expect(shared.PLATFORM_CONFIG).toHaveProperty("slack");
    });

    it("exports getPlatformConfig", () => {
      expect(shared.getPlatformConfig).toBeTypeOf("function");
    });
  });

  describe("integration: utilities work correctly when imported from index", () => {
    it("getInitials works", () => {
      expect(shared.getInitials("John Doe")).toBe("JD");
    });

    it("normalizePhone works", () => {
      expect(shared.normalizePhone("+1 (555) 123-4567")).toBe("+15551234567");
    });

    it("formatTime works", () => {
      const result = shared.formatTime(Date.now());
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("getPlatformConfig works", () => {
      const config = shared.getPlatformConfig("gmail");
      expect(config?.label).toBe("Gmail");
    });
  });
});
