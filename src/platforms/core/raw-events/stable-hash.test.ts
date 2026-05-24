import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { providerStableHash, stableId } from "./stable-hash.js";

describe("providerStableHash", () => {
  it("matches sha256 hex digest of the seed", () => {
    const seed = "slack:message:T123:C456:1234.5678:hello";
    const expected = createHash("sha256").update(seed).digest("hex");
    expect(providerStableHash(seed)).toBe(expected);
    expect(stableId(seed)).toBe(expected);
  });
});
