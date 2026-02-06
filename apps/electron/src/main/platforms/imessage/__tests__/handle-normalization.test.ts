import { describe, expect, it } from "vitest";
import { normalizeChatDbHandleIdentifier } from "../handle-normalization";

describe("normalizeChatDbHandleIdentifier", () => {
  it("strips trailing filtered suffix", () => {
    expect(normalizeChatDbHandleIdentifier("+15551234567(filtered)")).toBe(
      "+15551234567"
    );
  });

  it("strips trailing filtered suffix case-insensitively", () => {
    expect(normalizeChatDbHandleIdentifier("+15551234567(FILTERED)")).toBe(
      "+15551234567"
    );
  });

  it("strips filtered suffix with surrounding whitespace", () => {
    expect(normalizeChatDbHandleIdentifier("+15551234567 (filtered) ")).toBe(
      "+15551234567"
    );
  });

  it("does not modify handles without suffix", () => {
    expect(normalizeChatDbHandleIdentifier("friend@example.com")).toBe(
      "friend@example.com"
    );
  });

  it("does not strip non-suffix occurrences", () => {
    expect(
      normalizeChatDbHandleIdentifier("my(filtered)tag@example.com")
    ).toBe("my(filtered)tag@example.com");
  });
});

