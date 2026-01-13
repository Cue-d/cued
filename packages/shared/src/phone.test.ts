import { describe, expect, it } from "vitest";
import { normalizePhone, getPhoneVariants } from "./phone";

describe("normalizePhone", () => {
  it("normalizes phone with + prefix and formatting", () => {
    expect(normalizePhone("+1 (555) 123-4567")).toBe("+15551234567");
  });

  it("normalizes phone without + prefix", () => {
    expect(normalizePhone("555-123-4567")).toBe("5551234567");
  });

  it("normalizes international phone with + prefix", () => {
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("handles phone with only digits", () => {
    expect(normalizePhone("5551234567")).toBe("5551234567");
  });

  it("handles phone with + and only digits", () => {
    expect(normalizePhone("+15551234567")).toBe("+15551234567");
  });

  it("removes spaces, parentheses, and hyphens", () => {
    expect(normalizePhone("+1 555 123 4567")).toBe("+15551234567");
    expect(normalizePhone("(555) 123-4567")).toBe("5551234567");
  });

  it("handles empty string", () => {
    expect(normalizePhone("")).toBe("");
  });
});

describe("getPhoneVariants", () => {
  it("returns variants for US number with +1", () => {
    const variants = getPhoneVariants("+15551234567");
    expect(variants).toEqual(["+15551234567", "5551234567"]);
  });

  it("returns variants for 10-digit US number without +1", () => {
    const variants = getPhoneVariants("5551234567");
    expect(variants).toEqual(["5551234567", "+15551234567"]);
  });

  it("returns single variant for international (non-US) number", () => {
    const variants = getPhoneVariants("+442079460958");
    expect(variants).toEqual(["+442079460958"]);
  });

  it("returns single variant for short number", () => {
    const variants = getPhoneVariants("123456");
    expect(variants).toEqual(["123456"]);
  });

  it("normalizes input before generating variants", () => {
    const variants = getPhoneVariants("+1 (555) 123-4567");
    expect(variants).toEqual(["+15551234567", "5551234567"]);
  });

  it("normalizes 10-digit formatted number before generating variants", () => {
    const variants = getPhoneVariants("555-123-4567");
    expect(variants).toEqual(["5551234567", "+15551234567"]);
  });

  it("handles 11-digit number without +", () => {
    // 11 digits without + is not a standard US format, should not add +1
    const variants = getPhoneVariants("15551234567");
    expect(variants).toEqual(["15551234567"]);
  });

  it("handles +1 number with incorrect length", () => {
    // +1 but not 12 chars total (10 digit + +1)
    const variants = getPhoneVariants("+1555123456");
    expect(variants).toEqual(["+1555123456"]);
  });
});
