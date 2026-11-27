import { describe, expect, it } from "vitest";
import { AdapterWorkerError } from "../../platforms/core/runner.js";
import { isAdapterAuthInvalidation } from "./server.js";

describe("adapter auth invalidation", () => {
  it.each([
    "linkedin",
    "slack",
    "gmail",
  ])("recognizes typed %s auth failures from adapter workers", (platform) => {
    expect(
      isAdapterAuthInvalidation(
        platform,
        new AdapterWorkerError("Authentication failed", "auth_invalid"),
      ),
    ).toBe(true);
  });

  it("does not invalidate auth for transient or unrelated adapter failures", () => {
    expect(
      isAdapterAuthInvalidation("linkedin", new AdapterWorkerError("LinkedIn rate limited")),
    ).toBe(false);
    expect(
      isAdapterAuthInvalidation(
        "imessage",
        new AdapterWorkerError("Authentication failed", "auth_invalid"),
      ),
    ).toBe(false);
  });
});
