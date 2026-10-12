import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerStableHash, runAdapterWorker } from "./utils.js";

describe("providerStableHash", () => {
  it("matches sha256 hex digest of the seed", () => {
    const seed = "slack:message:T123:C456:1234.5678:hello";
    const expected = createHash("sha256").update(seed).digest("hex");
    expect(providerStableHash(seed)).toBe(expected);
  });
});

describe("adapter worker failures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it.each([true, false])("preserves auth classification: %s", async (authInvalid) => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runAdapterWorker(
      () => {
        throw new Error("provider failed");
      },
      () => authInvalid,
    );
    expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual({
      ok: false,
      error: "provider failed",
      ...(authInvalid ? { errorCode: "auth_invalid" } : {}),
    });
    expect(process.exitCode).toBe(1);
  });
});
