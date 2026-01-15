import { describe, it, expect } from "vitest";
import {
  normalizeEmail,
  emailsMatch,
  phonesMatch,
  findHandleMatch,
} from "./deterministic";

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  ADMIN@Company.Com  ")).toBe("admin@company.com");
  });

  it("removes Gmail dots", () => {
    expect(normalizeEmail("j.doe@gmail.com")).toBe("jdoe@gmail.com");
    expect(normalizeEmail("j.d.o.e@gmail.com")).toBe("jdoe@gmail.com");
  });

  it("removes Gmail plus-addressing", () => {
    expect(normalizeEmail("user+work@gmail.com")).toBe("user@gmail.com");
    expect(normalizeEmail("j.doe+tag@gmail.com")).toBe("jdoe@gmail.com");
  });

  it("handles googlemail.com the same as gmail.com", () => {
    expect(normalizeEmail("j.doe@googlemail.com")).toBe("jdoe@googlemail.com");
  });

  it("preserves dots for non-Gmail domains", () => {
    expect(normalizeEmail("j.doe@company.com")).toBe("j.doe@company.com");
  });

  it("removes plus-addressing for non-Gmail", () => {
    expect(normalizeEmail("user+tag@company.com")).toBe("user@company.com");
  });
});

describe("emailsMatch", () => {
  it("matches same email", () => {
    expect(emailsMatch("user@example.com", "user@example.com")).toBe(true);
  });

  it("matches Gmail variants", () => {
    expect(emailsMatch("j.doe@gmail.com", "jdoe@gmail.com")).toBe(true);
    expect(emailsMatch("user+work@gmail.com", "user@gmail.com")).toBe(true);
  });

  it("does not match different users", () => {
    expect(emailsMatch("user1@gmail.com", "user2@gmail.com")).toBe(false);
  });
});

describe("phonesMatch", () => {
  it("matches same phone", () => {
    expect(phonesMatch("+15551234567", "+15551234567")).toBe(true);
  });

  it("matches US phone variants", () => {
    expect(phonesMatch("+15551234567", "5551234567")).toBe(true);
    expect(phonesMatch("5551234567", "+15551234567")).toBe(true);
  });

  it("does not match different numbers", () => {
    expect(phonesMatch("+15551234567", "+15559876543")).toBe(false);
  });
});

describe("findHandleMatch", () => {
  it("finds email match", () => {
    const result = findHandleMatch(
      { emails: ["user@example.com"], phones: [] },
      { emails: ["USER@EXAMPLE.COM"], phones: [] }
    );
    expect(result).toEqual({ type: "email", value: "user@example.com" });
  });

  it("finds phone match", () => {
    const result = findHandleMatch(
      { emails: [], phones: ["+15551234567"] },
      { emails: [], phones: ["5551234567"] }
    );
    expect(result).toEqual({ type: "phone", value: "+15551234567" });
  });

  it("returns null for no match", () => {
    const result = findHandleMatch(
      { emails: ["a@example.com"], phones: [] },
      { emails: ["b@example.com"], phones: [] }
    );
    expect(result).toBeNull();
  });
});
