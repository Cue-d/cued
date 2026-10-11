import { describe, expect, it } from "vitest";
import type { DiscordApiClient } from "../api/client.js";
import { buildDiscordSyncBundle } from "./bundle.js";

describe("Discord initial coverage", () => {
  for (const poisoned of [false, true]) {
    it(`hydrates every channel across bounded runs (${poisoned ? "legacy false proofs" : "new account"})`, async () => {
      const channels = Array.from({ length: 12 }, (_, i) => ({
        id: `dm-${i}`,
        type: 1,
        recipients: [],
        last_message_id: String(1000 + i),
      }));
      const requests: Array<{ channel: string; before?: string | null; limit?: number }> = [];
      const client = {
        async getCurrentUser() {
          return { id: "self", username: "self" };
        },
        async listPrivateChannels() {
          return channels;
        },
        async listChannelMessages(
          channel: string,
          options: { before?: string | null; limit?: number },
        ) {
          requests.push({ channel, ...options });
          return [
            {
              id: channels.find((c) => c.id === channel)!.last_message_id,
              channel_id: channel,
              author: { id: "sender", username: "sender" },
              content: "fixture",
              timestamp: "2026-04-18T12:00:00.000Z",
            },
          ];
        },
      } as unknown as DiscordApiClient;
      let sourceCursor: unknown = poisoned
        ? {
            channels: Object.fromEntries(
              channels.map((c) =>
                // One skipped channel has new activity beyond its bogus discovery watermark.
                [c.id, { latestMessageId: c.id === "dm-11" ? "900" : c.last_message_id }],
              ),
            ),
          }
        : undefined;
      const proofs = new Map<string, Record<string, unknown>>();
      if (poisoned)
        for (const c of channels)
          proofs.set(`${c.id}:latest_messages`, {
            scopeKey: c.id,
            proofKind: "latest_messages",
            status: "complete",
            coverage: { latestMessageId: c.last_message_id },
          });
      const messages = new Set<string>();
      for (let run = 0; run < 4; run++) {
        const startRequests = requests.length;
        const bundle = await buildDiscordSyncBundle(
          { accountKey: "default" },
          {
            client,
            sourceCursor,
            syncProofs: [...proofs.values()],
            syncMessageChannelLimit: 5,
            backfillPageLimit: 0,
          },
        );
        sourceCursor = bundle.sourceCursor;
        expect(requests.length - startRequests).toBe([5, 5, 2, 0][run]);
        expect(bundle.hasMore).toBe(run < 2);
        for (const event of bundle.rawEvents)
          if (event.entityKind === "message") messages.add(event.id);
        for (const proof of bundle.proofs ?? []) {
          proofs.set(`${proof.scope.key}:${proof.proofKind}`, {
            scopeKey: proof.scope.key,
            proofKind: proof.proofKind,
            status: proof.status,
            coverage: proof.coverage,
            resumeCursor: proof.resumeCursor,
            lastObservedAt: proof.observedAt,
          });
          if (proof.proofKind === "latest_messages")
            expect(proof.stats?.hydratedThisRun).toBe(true);
        }
      }
      expect(messages.size).toBe(12);
      expect(new Set(requests.map((r) => r.channel)).size).toBe(12);
      expect(requests.every((r) => r.before === undefined && r.limit === 50)).toBe(true);
    });
  }
});
