import { describe, expect, it } from "vitest";
import {
  normalizePhone,
  getPhoneVariants,
  formatPhoneNumber,
  phonesMatch,
} from "./phone";

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

  it("handles 11-digit US number without + (leading 1)", () => {
    // 11 digits starting with 1 is common US format from contact apps
    const variants = getPhoneVariants("15551234567");
    expect(variants).toEqual(["15551234567", "+15551234567", "5551234567"]);
  });

  it("matches 11-digit format with +1 and 10-digit formats", () => {
    // These should all produce overlapping variants
    const elevenDigit = getPhoneVariants("15551234567");
    const withPlus = getPhoneVariants("+15551234567");
    const tenDigit = getPhoneVariants("5551234567");

    // Verify they can match each other
    expect(elevenDigit.some((v) => withPlus.includes(v))).toBe(true);
    expect(elevenDigit.some((v) => tenDigit.includes(v))).toBe(true);
    expect(withPlus.some((v) => tenDigit.includes(v))).toBe(true);
  });

  it("handles +1 number with incorrect length", () => {
    // +1 but not 12 chars total (10 digit + +1)
    const variants = getPhoneVariants("+1555123456");
    expect(variants).toEqual(["+1555123456"]);
  });
});

describe("formatPhoneNumber", () => {
  it("formats US number with +1 country code", () => {
    expect(formatPhoneNumber("+15551234567")).toBe("+1 (555) 123-4567");
  });

  it("formats US number with +1 and existing formatting", () => {
    expect(formatPhoneNumber("+1 (555) 123-4567")).toBe("+1 (555) 123-4567");
  });

  it("formats 10-digit US number without country code", () => {
    expect(formatPhoneNumber("5551234567")).toBe("(555) 123-4567");
  });

  it("formats 10-digit US number with existing formatting", () => {
    expect(formatPhoneNumber("(555) 123-4567")).toBe("(555) 123-4567");
    expect(formatPhoneNumber("555-123-4567")).toBe("(555) 123-4567");
  });

  it("preserves international numbers with + prefix", () => {
    expect(formatPhoneNumber("+442079460958")).toBe("+442079460958");
    expect(formatPhoneNumber("+44 20 7946 0958")).toBe("+44 20 7946 0958");
  });

  it("returns short numbers unchanged", () => {
    expect(formatPhoneNumber("123456")).toBe("123456");
  });

  it("returns non-standard numbers unchanged", () => {
    expect(formatPhoneNumber("12345")).toBe("12345");
    expect(formatPhoneNumber("1234567890123")).toBe("1234567890123");
  });

  it("handles empty string", () => {
    expect(formatPhoneNumber("")).toBe("");
  });

  it("handles real-world examples", () => {
    // Regression case: +12078005660 -> +1 (207) 800-5660
    expect(formatPhoneNumber("+12078005660")).toBe("+1 (207) 800-5660");
  });
});

describe("phonesMatch", () => {
  it("matches identical normalized numbers", () => {
    expect(phonesMatch("+15551234567", "+15551234567")).toBe(true);
    expect(phonesMatch("5551234567", "5551234567")).toBe(true);
  });

  it("matches US number with +1 against 10-digit", () => {
    expect(phonesMatch("+15551234567", "5551234567")).toBe(true);
    expect(phonesMatch("5551234567", "+15551234567")).toBe(true);
  });

  it("matches US number variants with formatting", () => {
    expect(phonesMatch("+1 (555) 123-4567", "555-123-4567")).toBe(true);
    expect(phonesMatch("(555) 123-4567", "+1-555-123-4567")).toBe(true);
  });

  it("matches 11-digit US number without + to other variants", () => {
    expect(phonesMatch("15551234567", "+15551234567")).toBe(true);
    expect(phonesMatch("15551234567", "5551234567")).toBe(true);
  });

  it("does not match different numbers", () => {
    expect(phonesMatch("+15551234567", "+15559876543")).toBe(false);
    expect(phonesMatch("5551234567", "5559876543")).toBe(false);
  });

  it("does not match international to US number", () => {
    // +44 number should not match US number
    expect(phonesMatch("+442079460958", "+15551234567")).toBe(false);
  });

  it("matches international numbers only when exact", () => {
    expect(phonesMatch("+442079460958", "+44 20 7946 0958")).toBe(true);
    expect(phonesMatch("+442079460958", "+442079460000")).toBe(false);
  });
});
