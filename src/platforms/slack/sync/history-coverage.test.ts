import { describe, expect, it } from "vitest";
import type { SlackTransport } from "../transport.js";
import { buildSlackSyncBundle, type SlackSourceCursor } from "./bundle.js";

describe("Slack durable initial history coverage", () => {
  it("repairs legacy empty-window proofs across pages and never repeats empty backfills", async () => {
    const calls: Array<{ channel: string; oldest?: string }> = [];
    const client: SlackTransport = {
      async testAuth() {
        return { ok: true, team_id: "T", user_id: "SELF" };
      },
      async listUsers() {
        return { users: [] };
      },
      async listConversations(types, cursor) {
        if (!types.includes("im")) return { conversations: [] };
        return cursor
          ? { conversations: [{ id: "D3", is_im: true }] }
          : {
              conversations: [
                { id: "D1", is_im: true },
                { id: "D2", is_im: true },
              ],
              nextCursor: "page2",
            };
      },
      async getConversationMembers() {
        return { members: [] };
      },
      async getHistory(channel, options) {
        calls.push({ channel, oldest: options?.oldest });
        return {
          messages:
            channel === "D2" || options?.oldest
              ? []
              : [
                  {
                    type: "message",
                    subtype: "bot_message",
                    bot_id: "BOT",
                    text: "old fixture",
                    ts: "1700000000.000001",
                  },
                ],
          hasMore: false,
        };
      },
      async getReplies() {
        return { messages: [], hasMore: false };
      },
    };
    let sourceCursor: SlackSourceCursor = {
      teamId: "T",
      selfUserId: "SELF",
      lastSyncAt: 1_780_000_000_000,
      knownConversationIds: ["D1", "D2", "D3"],
    };
    const durable = new Set<string>();
    let imported = 0;
    for (let run = 0; run < 8; run++) {
      const bundle = await buildSlackSyncBundle({
        client,
        sourceCursor,
        apiPageBudget: 1,
        syncProofs: ["D1", "D2", "D3"].map((scopeKey) => ({
          scopeKind: "conversation",
          scopeKey,
          proofKind: "messages",
          status: "complete",
          coverage: null,
        })),
      });
      sourceCursor = bundle.sourceCursor as SlackSourceCursor;
      imported += bundle.rawEvents.filter((event) => event.entityKind === "message").length;
      for (const proof of bundle.proofs ?? [])
        if (proof.proofKind === "history") durable.add(proof.scope.key);
      if (!bundle.hasMore) break;
    }
    expect(imported).toBe(2);
    expect([...durable].sort()).toEqual(["D1", "D2", "D3"]);
    expect(sourceCursor.hydratedConversationIds).toEqual(["D1", "D2", "D3"]);
    expect(calls.filter((call) => !call.oldest).map((call) => call.channel)).toEqual([
      "D1",
      "D2",
      "D3",
    ]);
    const next = await buildSlackSyncBundle({ client, sourceCursor });
    expect(next.syncMode).toBe("incremental");
    expect(next.proofs?.some((proof) => proof.proofKind === "history")).toBe(false);
    expect(calls.filter((call) => !call.oldest)).toHaveLength(3);
  });
  it("preserves the incremental watermark while repairing another channel", async () => {
    const checkpoint = 1_710_000_000_000;
    const missedMessageTs = "1710000600.000001";
    const client: SlackTransport = {
      async testAuth() {
        return { ok: true, team_id: "T", user_id: "SELF" };
      },
      async listUsers() {
        return { users: [] };
      },
      async listConversations(types) {
        return {
          conversations: types.includes("im")
            ? [
                { id: "A", is_im: true },
                { id: "B", is_im: true },
              ]
            : [],
        };
      },
      async getConversationMembers() {
        return { members: [] };
      },
      async getHistory(channel, options) {
        return {
          messages:
            channel === "A" && Number(options?.oldest ?? 0) < Number(missedMessageTs)
              ? [{ type: "message", user: "U", text: "catchup", ts: missedMessageTs }]
              : [],
          hasMore: false,
        };
      },
      async getReplies() {
        return { messages: [], hasMore: false };
      },
    };
    let sourceCursor: SlackSourceCursor = {
      teamId: "T",
      selfUserId: "SELF",
      lastSyncAt: checkpoint,
      knownConversationIds: ["A", "B"],
      hydratedConversationIds: ["A"],
    };
    for (let run = 0; run < 5; run++) {
      const repair = await buildSlackSyncBundle({ client, sourceCursor });
      sourceCursor = repair.sourceCursor as SlackSourceCursor;
      expect(sourceCursor.lastSyncAt).toBe(checkpoint);
      if (!repair.hasMore) break;
    }
    expect(sourceCursor.scan).toBeUndefined();
    expect(sourceCursor.hydratedConversationIds).toEqual(["A", "B"]);
    const catchup = await buildSlackSyncBundle({ client, sourceCursor });
    expect(catchup.syncMode).toBe("incremental");
    expect(catchup.rawEvents.filter((event) => event.entityKind === "message")).toHaveLength(1);
    expect((catchup.sourceCursor as SlackSourceCursor).lastSyncAt).toBeGreaterThan(checkpoint);
  });
});
