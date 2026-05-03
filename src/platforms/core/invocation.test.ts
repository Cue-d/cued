import { describe, expect, it } from "vitest";
import { buildAdapterInvocationEnv, readAdapterInvocationEnv } from "./invocation.js";

describe("adapter invocation env", () => {
  it("preserves legacy cursor env vars while adding generic cursor env", () => {
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
      CUED_LINKEDIN_SOURCE_CURSOR: JSON.stringify({
        lastSyncAt: 123,
        syncToken: "sync-token",
      }),
      CUED_LINKEDIN_LAST_SYNC_AT: "123",
      CUED_LINKEDIN_SYNC_TOKEN: "sync-token",
    });
  });

  it("serializes proof rows for generic and Discord legacy proof env", () => {
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
    expect(env.CUED_DISCORD_SYNC_PROOFS).toBe(env.CUED_SYNC_PROOFS);
  });

  it("reads generic invocation env when platform legacy env is absent", () => {
    expect(
      readAdapterInvocationEnv("slack", {
        CUED_SYNC_SOURCE_CURSOR: JSON.stringify({ lastSyncAt: 123 }),
        CUED_SYNC_PROOFS: JSON.stringify([{ scopeKey: "C1", proofKind: "messages" }]),
      }),
    ).toEqual({
      sourceCursor: { lastSyncAt: 123 },
      syncProofs: [{ scopeKey: "C1", proofKind: "messages" }],
    });
  });
});
