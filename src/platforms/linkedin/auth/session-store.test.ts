import { describe, expect, it } from "vitest";
import { parseLinkedInSessionSecret } from "./session-store.js";

describe("LinkedIn session storage", () => {
  it("preserves the browser user agent with the captured session", () => {
    expect(
      parseLinkedInSessionSecret({
        cookies: [],
        userAgent: "Mozilla/5.0 Chrome/150.0.0.0",
      }).userAgent,
    ).toBe("Mozilla/5.0 Chrome/150.0.0.0");
  });
});
