import { describe, expect, it } from "vitest";
import { normalizePhone, toE164 } from "./phone.js";

describe("phone utils", () => {
  it("normalizes NANP numbers into a shared 10-digit identity form", () => {
    expect(normalizePhone("773 744 1662")).toBe("7737441662");
    expect(normalizePhone("+17737441662")).toBe("7737441662");
    expect(normalizePhone("1 (773) 744-1662")).toBe("7737441662");
  });

  it("preserves international E.164 numbers", () => {
    expect(normalizePhone("+919008514179")).toBe("+919008514179");
  });

  it("formats canonical phone values back into E.164 when needed", () => {
    expect(toE164("7737441662")).toBe("+17737441662");
    expect(toE164("+919008514179")).toBe("+919008514179");
  });
});
