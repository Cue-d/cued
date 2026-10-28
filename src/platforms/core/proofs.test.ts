import { describe, expect, it } from "vitest";
import { assertKnownSyncProofKindContract } from "./proofs.js";

describe("sync proof contracts", () => {
  it("requires contracts for emitted proof shapes", () => {
    expect(() =>
      assertKnownSyncProofKindContract("slack", {
        scope: { kind: "conversation", key: "C123" },
        proofKind: "replies",
        status: "complete",
        observedAt: 1,
      }),
    ).not.toThrow();

    expect(() =>
      assertKnownSyncProofKindContract("slack", {
        scope: { kind: "account", key: "workspace" },
        proofKind: "replies",
        status: "complete",
        observedAt: 1,
      }),
    ).toThrow("No sync proof contract for slack:account:replies");
  });
});
