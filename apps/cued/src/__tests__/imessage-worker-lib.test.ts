import { describe, expect, it } from "vitest";
import { resolveIMessageLoader } from "../workers/imessage-worker-lib.js";

describe("imessage worker loader resolution", () => {
  it("prefers explicit native binary overrides", () => {
    expect(
      resolveIMessageLoader(
        {
          CUED_IMESSAGE_NATIVE_BINARY: "/tmp/CuedNative",
          CUED_IMESSAGE_DB_PATH: "/tmp/chat.db",
        },
        "/tmp/repo",
      ),
    ).toEqual({
      kind: "native",
      path: "/tmp/CuedNative",
    });
  });

  it("falls back to the TypeScript reader path without a native binary", () => {
    expect(
      resolveIMessageLoader(
        {
          CUED_IMESSAGE_DB_PATH: "/tmp/chat.db",
        },
        "/tmp/repo",
      ),
    ).toEqual({
      kind: "ts",
      path: "/tmp/chat.db",
    });
  });
});
