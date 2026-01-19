import { describe, it, expect } from "vitest";
import { getInitials } from "../index";

describe("getInitials", () => {
  describe("empty and edge cases", () => {
    it("returns empty string for empty input", () => {
      expect(getInitials("")).toBe("");
    });

    it("handles whitespace-only input", () => {
      expect(getInitials("   ")).toBe("");
    });
  });

  describe("single name", () => {
    it("returns single uppercase initial for single name", () => {
      expect(getInitials("Alice")).toBe("A");
    });

    it("handles lowercase single name", () => {
      expect(getInitials("bob")).toBe("B");
    });

    it("handles single character name", () => {
      expect(getInitials("X")).toBe("X");
    });
  });

  describe("multiple names", () => {
    it("returns two initials for two names", () => {
      expect(getInitials("John Doe")).toBe("JD");
    });

    it("returns only first two initials for three+ names", () => {
      expect(getInitials("John Paul Jones")).toBe("JP");
    });

    it("handles mixed case names", () => {
      expect(getInitials("jane DOE")).toBe("JD");
    });

    it("handles extra spaces between names", () => {
      expect(getInitials("John  Doe")).toBe("JD");
    });
  });

  describe("phone numbers", () => {
    it("returns # for phone number starting with +", () => {
      expect(getInitials("+1234567890")).toBe("#");
    });

    it("returns # for phone number starting with digit", () => {
      expect(getInitials("1234567890")).toBe("#");
    });

    it("returns # for formatted phone number", () => {
      expect(getInitials("+1 (555) 123-4567")).toBe("#");
    });
  });

  describe("email addresses", () => {
    it("returns uppercase first character for email", () => {
      expect(getInitials("user@example.com")).toBe("U");
    });

    it("handles lowercase email", () => {
      expect(getInitials("alice@company.org")).toBe("A");
    });

    it("handles uppercase email", () => {
      expect(getInitials("BOB@test.io")).toBe("B");
    });
  });
});
