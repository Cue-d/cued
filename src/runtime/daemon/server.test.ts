import { describe, expect, it } from "vitest";
import { AdapterWorkerError } from "../../platforms/core/runner.js";
import { isAdapterAuthInvalidation, isDisconnectedSocketError } from "./server.js";

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

describe("daemon socket errors", () => {
  it("classifies disconnected clients as non-fatal IPC errors", () => {
    for (const code of ["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED"]) {
      const error = new Error(code) as NodeJS.ErrnoException;
      error.code = code;
      expect(isDisconnectedSocketError(error)).toBe(true);
    }
  });

  it("does not hide unexpected socket errors", () => {
    const error = new Error("permission denied") as NodeJS.ErrnoException;
    error.code = "EACCES";
    expect(isDisconnectedSocketError(error)).toBe(false);
    expect(isDisconnectedSocketError("EPIPE")).toBe(false);
  });
});
