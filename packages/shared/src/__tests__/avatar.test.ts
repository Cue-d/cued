import { describe, it, expect } from "vitest";
import { normalizePublicAvatarUrl } from "../avatar";

describe("normalizePublicAvatarUrl", () => {
  it("normalizes valid http/https URLs", () => {
    expect(normalizePublicAvatarUrl("https://example.com/avatar.png")).toBe(
      "https://example.com/avatar.png"
    );
    expect(normalizePublicAvatarUrl(" http://example.com ")).toBe(
      "http://example.com/"
    );
  });

  it("rejects empty and non-http protocols", () => {
    expect(normalizePublicAvatarUrl("")).toBeUndefined();
    expect(normalizePublicAvatarUrl("   ")).toBeUndefined();
    expect(normalizePublicAvatarUrl("file:///tmp/avatar.png")).toBeUndefined();
    expect(normalizePublicAvatarUrl("cued-contact-avatar://avatar/a.png")).toBeUndefined();
  });

  it("rejects invalid URLs", () => {
    expect(normalizePublicAvatarUrl("not-a-url")).toBeUndefined();
    expect(normalizePublicAvatarUrl(null)).toBeUndefined();
    expect(normalizePublicAvatarUrl(undefined)).toBeUndefined();
  });
});
