import { describe, expect, it } from "vitest";
import {
  buildAdapterInvocationEnv,
  readAdapterInvocationEnv,
  selectAdapterInvocationProofs,
} from "./invocation.js";

describe("adapter invocation env", () => {
  it("serializes source cursors through the generic env", () => {
    const env = buildAdapterInvocationEnv({
      platform: "linkedin",
      checkpointSourceCursorJson: JSON.stringify({
        lastSyncAt: 123,
        syncToken: "sync-token",
      }),
    });

    expect(env).toEqual({
      CUED_SYNC_SOURCE_CURSOR: JSON.stringify({
        lastSyncAt: 123,
        syncToken: "sync-token",
      }),
    });
  });

  it("serializes proof rows through the generic env", () => {
    const env = buildAdapterInvocationEnv({
      platform: "discord",
      proofs: [
        {
          scope_kind: "conversation",
          scope_key: "dm-1",
          proof_kind: "messages",
          status: "running",
          resume_cursor_json: JSON.stringify({ before: "100" }),
          coverage_json: JSON.stringify({ newestMessageId: "200" }),
          stats_json: JSON.stringify({ threadRootCount: 3 }),
          last_observed_at: 456,
        },
      ],
    });

    const parsed = JSON.parse(env.CUED_SYNC_PROOFS ?? "[]");
    expect(parsed).toEqual([
      {
        scopeKind: "conversation",
        scopeKey: "dm-1",
        proofKind: "messages",
        status: "running",
        resumeCursor: { before: "100" },
        coverage: { newestMessageId: "200" },
        stats: { threadRootCount: 3 },
        lastObservedAt: 456,
      },
    ]);
    expect(env).not.toHaveProperty("CUED_DISCORD_SYNC_PROOFS");
  });

  it("reads generic invocation env", () => {
    expect(
      readAdapterInvocationEnv({
        CUED_SYNC_SOURCE_CURSOR: JSON.stringify({ lastSyncAt: 123 }),
        CUED_SYNC_PROOFS: JSON.stringify([{ scopeKey: "C1", proofKind: "messages" }]),
      }),
    ).toEqual({
      sourceCursor: { lastSyncAt: 123 },
      syncProofs: [{ scopeKey: "C1", proofKind: "messages" }],
    });
  });

  it("bounds Slack invocation proofs to the active conversation", () => {
    const proofs = [
      proofRow("conversation", "C1", "messages", "complete"),
      proofRow("conversation", "C1", "replies", "running"),
      proofRow("conversation", "C2", "messages", "running"),
      proofRow("account", "workspace", "messages", "running"),
    ];

    expect(
      selectAdapterInvocationProofs({
        platform: "slack",
        proofs,
        sourceCursor: {
          scan: {
            activeConversationId: "C1",
          },
        },
      }),
    ).toEqual([proofs[0], proofs[1]]);
  });

  it("bounds LinkedIn invocation proofs to active account and message resume state", () => {
    const proofs = [
      proofRow("account", "default", "discovery", "running"),
      proofRow("conversation", "urn:li:fs_conversation:CONV_LONG", "messages", "running"),
      proofRow("conversation", "urn:li:fs_conversation:OTHER", "messages", "running"),
      proofRow("conversation", "urn:li:fs_conversation:CONV_LONG", "discovery", "complete"),
    ];

    expect(
      selectAdapterInvocationProofs({
        platform: "linkedin",
        proofs,
        sourceCursor: {
          scan: {
            activeConversation: {
              entityURN: "urn:li:fsd_conversation:CONV_LONG",
            },
          },
        },
      }),
    ).toEqual([proofs[0], proofs[1]]);
  });
});

function proofRow(scopeKind: string, scopeKey: string, proofKind: string, status: string) {
  return {
    scope_kind: scopeKind,
    scope_key: scopeKey,
    proof_kind: proofKind,
    status,
    resume_cursor_json: null,
    coverage_json: null,
    stats_json: null,
    last_observed_at: 1,
  };
}
