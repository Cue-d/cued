import { describe, expect, it } from "vitest";
import {
  assertKnownSyncProofKindContract,
  getSyncProofKindContract,
  listSyncProofKindContracts,
} from "./proofs.js";

describe("sync proof contracts", () => {
  it("documents non-standard proof kinds used by adapters", () => {
    expect(
      getSyncProofKindContract("discord", {
        scope: { kind: "conversation", key: "dm-1" },
        proofKind: "latest_messages",
      }),
    ).toMatchObject({
      platform: "discord",
      scopeKind: "conversation",
      proofKind: "latest_messages",
      completeMeans: expect.stringContaining("newest known message edge"),
    });
  });

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

  it("keeps platform contracts discoverable", () => {
    expect(listSyncProofKindContracts("linkedin").map((contract) => contract.proofKind)).toEqual([
      "discovery",
      "messages",
    ]);
  });
});
