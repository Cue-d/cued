import { afterEach, describe, expect, it } from "vitest";
import type { DiscordApiClient } from "../api/client.js";
import {
  buildDiscordSyncBundle,
  getDiscordSyncBackfillPageLimit,
  getDiscordSyncMessageChannelLimit,
  getDiscordSyncMessagesPerChannelLimit,
} from "./bundle.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("buildDiscordSyncBundle", () => {
  it("hydrates only the most recent DM messages during sync", async () => {
    const hydratedChannels: Array<{ channelId: string; limit?: number }> = [];

    const bundle = await buildDiscordSyncBundle(
      { accountKey: "default" },
      {
        syncMessageChannelLimit: 2,
        syncMessagesPerChannelLimit: 3,
        client: {
          async getCurrentUser() {
            return {
              id: "u-self",
              username: "avery",
              global_name: "Avery",
            };
          },
          async listPrivateChannels() {
            return [
              {
                id: "dm-1",
                type: 1,
                recipients: [{ id: "u-1", username: "ava" }],
                last_message_id: "100",
              },
              {
                id: "dm-2",
                type: 1,
                recipients: [{ id: "u-2", username: "ben" }],
                last_message_id: "300",
              },
              {
                id: "dm-3",
                type: 1,
                recipients: [{ id: "u-3", username: "cam" }],
                last_message_id: "200",
              },
            ];
          },
          async listChannelMessages(channelId: string, options?: { limit?: number }) {
            hydratedChannels.push({ channelId, limit: options?.limit });
            return [
              {
                id: `${channelId}-latest-3`,
                channel_id: channelId,
                author: {
                  id: `sender-${channelId}`,
                  username: `user-${channelId}`,
                },
                content: `latest-3-${channelId}`,
                timestamp: "2026-04-18T12:00:03.000Z",
              },
              {
                id: `${channelId}-latest-2`,
                channel_id: channelId,
                author: {
                  id: `sender-${channelId}`,
                  username: `user-${channelId}`,
                },
                content: `latest-2-${channelId}`,
                timestamp: "2026-04-18T12:00:02.000Z",
              },
              {
                id: `${channelId}-latest-1`,
                channel_id: channelId,
                author: {
                  id: `sender-${channelId}`,
                  username: `user-${channelId}`,
                },
                content: `latest-1-${channelId}`,
                timestamp: "2026-04-18T12:00:00.000Z",
              },
            ];
          },
        } as unknown as DiscordApiClient,
      },
    );

    expect(hydratedChannels).toEqual([
      { channelId: "dm-2", limit: 3 },
      { channelId: "dm-3", limit: 3 },
    ]);
    expect(bundle.rawEvents.filter((event) => event.entityKind === "message")).toHaveLength(6);
    expect(
      bundle.rawEvents
        .filter((event) => event.entityKind === "message")
        .map((event) => ({
          conversationKey: (event.payload as { sourceConversationKey: string })
            .sourceConversationKey,
          sourceMessageKey: (event.payload as { sourceMessageKey: string }).sourceMessageKey,
        })),
    ).toEqual([
      {
        conversationKey: "discord:channel:dm-2",
        sourceMessageKey: "discord:message:dm-2:dm-2-latest-1",
      },
      {
        conversationKey: "discord:channel:dm-2",
        sourceMessageKey: "discord:message:dm-2:dm-2-latest-2",
      },
      {
        conversationKey: "discord:channel:dm-2",
        sourceMessageKey: "discord:message:dm-2:dm-2-latest-3",
      },
      {
        conversationKey: "discord:channel:dm-3",
        sourceMessageKey: "discord:message:dm-3:dm-3-latest-1",
      },
      {
        conversationKey: "discord:channel:dm-3",
        sourceMessageKey: "discord:message:dm-3:dm-3-latest-2",
      },
      {
        conversationKey: "discord:channel:dm-3",
        sourceMessageKey: "discord:message:dm-3:dm-3-latest-3",
      },
    ]);
    expect(bundle.diagnostics).toEqual({
      discordHydration: {
        selectedChannelCount: 2,
        attemptedChannelCount: 2,
        completedChannelCount: 2,
        messageLimitPerChannel: 3,
        partial: false,
        breakChannelId: null,
        error: null,
        rateLimited: false,
        retryAfterMs: null,
      },
      discordBackfill: {
        selectedChannelCount: 0,
        attemptedChannelCount: 0,
        completedChannelCount: 0,
        messageLimitPerChannel: 100,
        partial: false,
        breakChannelId: null,
        error: null,
        rateLimited: false,
        retryAfterMs: null,
      },
    });
    expect(bundle.sourceCursor).toEqual({
      userId: "u-self",
      discoveredAt: expect.any(Number),
      lastSyncAt: expect.any(Number),
      channels: {
        "dm-1": { latestMessageId: "100" },
        "dm-2": { latestMessageId: "300" },
        "dm-3": { latestMessageId: "200" },
      },
    });
    expect(findDiscordProof(bundle, "account", "u-self", "discovery")).toEqual(
      expect.objectContaining({
        status: "complete",
        completedAt: expect.any(Number),
        stats: {
          discoveredDmCount: 3,
        },
      }),
    );
    expect(findDiscordProof(bundle, "conversation", "dm-2", "discovery")).toEqual(
      expect.objectContaining({
        status: "complete",
        coverage: {
          latestMessageId: "300",
        },
      }),
    );
    expect(findDiscordProof(bundle, "conversation", "dm-2", "latest_messages")).toEqual(
      expect.objectContaining({
        status: "complete",
        coverage: {
          latestMessageId: "300",
          previousLatestMessageId: null,
        },
        stats: {
          hydratedThisRun: true,
          messagesFetched: 3,
        },
      }),
    );
    expect(findDiscordProof(bundle, "conversation", "dm-2", "messages")).toEqual(
      expect.objectContaining({
        status: "running",
        resumeCursor: {
          before: "dm-2-latest-1",
        },
        coverage: {
          oldestMessageId: "dm-2-latest-1",
          newestMessageId: "dm-2-latest-3",
        },
      }),
    );
    expect(bundle.hasMore).toBe(true);
    expect(bundle.continuation).toEqual({
      reason: "scoped_proof_continuation",
      detail: "Discord direct-message history proof is still running",
      scope: {
        kind: "conversation",
        key: "dm-2",
        proofKind: "messages",
      },
    });
    expect(findDiscordProof(bundle, "conversation", "dm-1", "latest_messages")).toBeUndefined();
  });

  it("reports partial hydration diagnostics when a DM history fetch fails", async () => {
    const hydratedChannelIds: string[] = [];

    const bundle = await buildDiscordSyncBundle(
      { accountKey: "default" },
      {
        syncMessageChannelLimit: 3,
        syncMessagesPerChannelLimit: 50,
        client: {
          async getCurrentUser() {
            return {
              id: "u-self",
              username: "avery",
              global_name: "Avery",
            };
          },
          async listPrivateChannels() {
            return [
              {
                id: "dm-1",
                type: 1,
                recipients: [{ id: "u-1", username: "ava" }],
                last_message_id: "300",
              },
              {
                id: "dm-2",
                type: 1,
                recipients: [{ id: "u-2", username: "ben" }],
                last_message_id: "200",
              },
              {
                id: "dm-3",
                type: 1,
                recipients: [{ id: "u-3", username: "cam" }],
                last_message_id: "100",
              },
            ];
          },
          async listChannelMessages(channelId: string) {
            hydratedChannelIds.push(channelId);
            if (channelId === "dm-2") {
              throw new Error("Discord API rate limited");
            }
            return [
              {
                id: `${channelId}-latest`,
                channel_id: channelId,
                author: {
                  id: `sender-${channelId}`,
                  username: `user-${channelId}`,
                },
                content: `latest-${channelId}`,
                timestamp: "2026-04-18T12:00:00.000Z",
              },
            ];
          },
        } as unknown as DiscordApiClient,
      },
    );

    expect(hydratedChannelIds).toEqual(["dm-1", "dm-2"]);
    expect(bundle.rawEvents.filter((event) => event.entityKind === "message")).toHaveLength(1);
    expect(bundle.diagnostics).toEqual({
      discordHydration: {
        selectedChannelCount: 3,
        attemptedChannelCount: 2,
        completedChannelCount: 1,
        messageLimitPerChannel: 50,
        partial: true,
        breakChannelId: "dm-2",
        error: "Discord API rate limited",
        rateLimited: true,
        retryAfterMs: null,
      },
      discordBackfill: {
        selectedChannelCount: 0,
        attemptedChannelCount: 0,
        completedChannelCount: 0,
        messageLimitPerChannel: 100,
        partial: false,
        breakChannelId: null,
        error: null,
        rateLimited: false,
        retryAfterMs: null,
      },
    });
    expect(findDiscordProof(bundle, "account", "u-self", "discovery")).toEqual(
      expect.objectContaining({
        status: "complete",
      }),
    );
    expect(findDiscordProof(bundle, "conversation", "dm-1", "latest_messages")).toEqual(
      expect.objectContaining({
        status: "complete",
      }),
    );
    expect(findDiscordProof(bundle, "conversation", "dm-2", "latest_messages")).toEqual(
      expect.objectContaining({
        status: "failed",
        completedAt: null,
        resumeCursor: {
          latestMessageId: "200",
        },
        coverage: {
          latestMessageId: "200",
          previousLatestMessageId: null,
        },
        error: {
          message: "Discord API rate limited",
          retryAfterMs: null,
        },
      }),
    );
    expect(findDiscordProof(bundle, "conversation", "dm-3", "latest_messages")).toBeUndefined();
  });

  it("uses persisted Discord cursors to fetch only changed DMs and paginate older pages", async () => {
    const fetchedRequests: Array<{
      channelId: string;
      before?: string | null;
      after?: string | null;
      limit?: number;
    }> = [];

    const bundle = await buildDiscordSyncBundle(
      { accountKey: "default" },
      {
        syncMessageChannelLimit: 1,
        client: {
          async getCurrentUser() {
            return {
              id: "u-self",
              username: "avery",
              global_name: "Avery",
            };
          },
          async listPrivateChannels() {
            return [
              {
                id: "dm-1",
                type: 1,
                recipients: [{ id: "u-1", username: "ava" }],
                last_message_id: "350",
              },
              {
                id: "dm-2",
                type: 1,
                recipients: [{ id: "u-2", username: "ben" }],
                last_message_id: "200",
              },
              {
                id: "dm-3",
                type: 1,
                recipients: [{ id: "u-3", username: "cam" }],
                last_message_id: "150",
              },
            ];
          },
          async listChannelMessages(
            channelId: string,
            options?: { before?: string | null; after?: string | null; limit?: number },
          ) {
            fetchedRequests.push({
              channelId,
              before: options?.before,
              after: options?.after,
              limit: options?.limit,
            });

            if (channelId === "dm-1" && !options?.before) {
              return buildDescendingDiscordMessages(channelId, 350, 251);
            }
            if (channelId === "dm-1" && options?.before === "251") {
              return buildDescendingDiscordMessages(channelId, 250, 151);
            }
            if (channelId === "dm-3") {
              return [
                {
                  id: "150",
                  channel_id: channelId,
                  author: {
                    id: "sender-dm-3",
                    username: "user-dm-3",
                  },
                  content: "latest-dm-3",
                  timestamp: "2026-04-18T12:00:00.000Z",
                },
              ];
            }
            return [];
          },
        } as unknown as DiscordApiClient,
        sourceCursor: {
          userId: "u-self",
          discoveredAt: 1_710_000_000_000,
          lastSyncAt: 1_710_000_000_000,
          channels: {
            "dm-1": { latestMessageId: "150" },
            "dm-2": { latestMessageId: "200" },
          },
        },
        syncProofs: [
          {
            scopeKey: "dm-1",
            proofKind: "latest_messages",
            status: "complete",
            coverage: { latestMessageId: "150" },
            resumeCursor: null,
            lastObservedAt: 100,
          },
          {
            scopeKey: "dm-2",
            proofKind: "latest_messages",
            status: "complete",
            coverage: { latestMessageId: "200" },
            resumeCursor: null,
            lastObservedAt: 100,
          },
        ],
      },
    );

    expect(fetchedRequests).toEqual([
      {
        channelId: "dm-1",
        before: null,
        after: undefined,
        limit: 100,
      },
      {
        channelId: "dm-1",
        before: "251",
        after: undefined,
        limit: 100,
      },
      {
        channelId: "dm-1",
        before: "151",
        after: undefined,
        limit: 100,
      },
      {
        channelId: "dm-3",
        before: undefined,
        after: undefined,
        limit: 50,
      },
    ]);
    expect(bundle.rawEvents.filter((event) => event.entityKind === "message")).toHaveLength(201);
    expect(bundle.diagnostics).toEqual({
      discordHydration: {
        selectedChannelCount: 2,
        attemptedChannelCount: 2,
        completedChannelCount: 2,
        messageLimitPerChannel: 50,
        partial: false,
        breakChannelId: null,
        error: null,
        rateLimited: false,
        retryAfterMs: null,
      },
      discordBackfill: {
        selectedChannelCount: 0,
        attemptedChannelCount: 0,
        completedChannelCount: 0,
        messageLimitPerChannel: 100,
        partial: false,
        breakChannelId: null,
        error: null,
        rateLimited: false,
        retryAfterMs: null,
      },
    });
    expect(bundle.sourceCursor).toEqual({
      userId: "u-self",
      discoveredAt: expect.any(Number),
      lastSyncAt: expect.any(Number),
      channels: {
        "dm-1": { latestMessageId: "350" },
        "dm-2": { latestMessageId: "200" },
        "dm-3": { latestMessageId: "150" },
      },
    });
    expect(findDiscordProof(bundle, "conversation", "dm-1", "latest_messages")).toEqual(
      expect.objectContaining({
        status: "complete",
        coverage: {
          latestMessageId: "350",
          previousLatestMessageId: "150",
        },
        stats: {
          hydratedThisRun: true,
          messagesFetched: 200,
        },
      }),
    );
    expect(findDiscordProof(bundle, "conversation", "dm-1", "messages")).toBeUndefined();
    expect(findDiscordProof(bundle, "conversation", "dm-2", "latest_messages")).toEqual(
      expect.objectContaining({
        status: "complete",
        coverage: {
          latestMessageId: "200",
          previousLatestMessageId: "200",
        },
        stats: {
          hydratedThisRun: false,
          messagesFetched: 0,
        },
      }),
    );
    expect(findDiscordProof(bundle, "conversation", "dm-3", "messages")).toEqual(
      expect.objectContaining({
        status: "complete",
        resumeCursor: null,
        coverage: {
          oldestMessageId: "150",
          newestMessageId: "150",
        },
      }),
    );
    expect(bundle.hasMore).toBe(false);
  });

  it("hydrates DMs that have a checkpoint cursor but no latest-message proof", async () => {
    const fetchedRequests: Array<{ channelId: string; before?: string | null; limit?: number }> =
      [];

    const bundle = await buildDiscordSyncBundle(
      { accountKey: "default" },
      {
        syncMessageChannelLimit: 1,
        client: {
          async getCurrentUser() {
            return {
              id: "u-self",
              username: "avery",
              global_name: "Avery",
            };
          },
          async listPrivateChannels() {
            return [
              {
                id: "dm-1",
                type: 1,
                recipients: [{ id: "u-1", username: "ava" }],
                last_message_id: "300",
              },
              {
                id: "dm-2",
                type: 1,
                recipients: [{ id: "u-2", username: "ben" }],
                last_message_id: "200",
              },
            ];
          },
          async listChannelMessages(
            channelId: string,
            options?: { before?: string | null; limit?: number },
          ) {
            fetchedRequests.push({
              channelId,
              before: options?.before,
              limit: options?.limit,
            });
            return [
              {
                id: channelId === "dm-1" ? "300" : "200",
                channel_id: channelId,
                author: {
                  id: `sender-${channelId}`,
                  username: `user-${channelId}`,
                },
                content: `latest-${channelId}`,
                timestamp: "2026-04-18T12:00:00.000Z",
              },
            ];
          },
        } as unknown as DiscordApiClient,
        sourceCursor: {
          userId: "u-self",
          discoveredAt: 1_710_000_000_000,
          lastSyncAt: 1_710_000_000_000,
          channels: {
            "dm-1": { latestMessageId: "300" },
            "dm-2": { latestMessageId: "200" },
          },
        },
        syncProofs: [
          {
            scopeKey: "dm-1",
            proofKind: "latest_messages",
            status: "complete",
            coverage: { latestMessageId: "300" },
            resumeCursor: null,
            lastObservedAt: 100,
          },
        ],
      },
    );

    expect(fetchedRequests).toEqual([{ channelId: "dm-2", before: undefined, limit: 50 }]);
    expect(findDiscordProof(bundle, "conversation", "dm-2", "latest_messages")).toEqual(
      expect.objectContaining({
        status: "complete",
        coverage: {
          latestMessageId: "200",
          previousLatestMessageId: null,
        },
      }),
    );
  });

  it("continues incomplete historical message proofs with before pagination", async () => {
    const fetchedRequests: Array<{ channelId: string; before?: string | null; limit?: number }> =
      [];

    const bundle = await buildDiscordSyncBundle(
      { accountKey: "default" },
      {
        syncMessageChannelLimit: 0,
        backfillPageLimit: 1,
        client: {
          async getCurrentUser() {
            return {
              id: "u-self",
              username: "avery",
              global_name: "Avery",
            };
          },
          async listPrivateChannels() {
            return [
              {
                id: "dm-1",
                type: 1,
                recipients: [{ id: "u-1", username: "ava" }],
                last_message_id: "350",
              },
            ];
          },
          async listChannelMessages(
            channelId: string,
            options?: { before?: string | null; limit?: number },
          ) {
            fetchedRequests.push({
              channelId,
              before: options?.before,
              limit: options?.limit,
            });
            return buildDescendingDiscordMessages(channelId, 249, 150);
          },
        } as unknown as DiscordApiClient,
        sourceCursor: {
          userId: "u-self",
          discoveredAt: 1_710_000_000_000,
          lastSyncAt: 1_710_000_000_000,
          channels: {
            "dm-1": { latestMessageId: "350" },
          },
        },
        syncProofs: [
          {
            scopeKey: "dm-1",
            proofKind: "latest_messages",
            status: "complete",
            coverage: { latestMessageId: "350" },
            resumeCursor: null,
            lastObservedAt: 100,
          },
          {
            scopeKey: "dm-1",
            proofKind: "messages",
            status: "running",
            coverage: { oldestMessageId: "250", newestMessageId: "350" },
            resumeCursor: { before: "250" },
            lastObservedAt: 100,
          },
        ],
      },
    );

    expect(fetchedRequests).toEqual([{ channelId: "dm-1", before: "250", limit: 100 }]);
    expect(bundle.rawEvents.filter((event) => event.entityKind === "message")).toHaveLength(100);
    expect(bundle.diagnostics?.discordBackfill).toEqual({
      selectedChannelCount: 1,
      attemptedChannelCount: 1,
      completedChannelCount: 1,
      messageLimitPerChannel: 100,
      partial: false,
      breakChannelId: null,
      error: null,
      rateLimited: false,
      retryAfterMs: null,
    });
    expect(findDiscordProof(bundle, "conversation", "dm-1", "messages")).toEqual(
      expect.objectContaining({
        status: "running",
        resumeCursor: {
          before: "150",
        },
        coverage: {
          oldestMessageId: "150",
          newestMessageId: "350",
        },
        stats: {
          messagesFetched: 100,
          messageLimit: 100,
          backfill: true,
        },
      }),
    );
    expect(bundle.hasMore).toBe(true);
  });

  it("fails non-advancing historical backfill instead of requeueing resume forever", async () => {
    const fetchedRequests: Array<{ channelId: string; before?: string | null; limit?: number }> =
      [];

    const bundle = await buildDiscordSyncBundle(
      { accountKey: "default" },
      {
        syncMessageChannelLimit: 0,
        backfillPageLimit: 1,
        client: {
          async getCurrentUser() {
            return {
              id: "u-self",
              username: "avery",
              global_name: "Avery",
            };
          },
          async listPrivateChannels() {
            return [
              {
                id: "dm-1",
                type: 1,
                recipients: [{ id: "u-1", username: "ava" }],
                last_message_id: "350",
              },
            ];
          },
          async listChannelMessages(
            channelId: string,
            options?: { before?: string | null; limit?: number },
          ) {
            fetchedRequests.push({
              channelId,
              before: options?.before,
              limit: options?.limit,
            });
            return buildDescendingDiscordMessages(channelId, 349, 250);
          },
        } as unknown as DiscordApiClient,
        sourceCursor: {
          userId: "u-self",
          discoveredAt: 1_710_000_000_000,
          lastSyncAt: 1_710_000_000_000,
          channels: {
            "dm-1": { latestMessageId: "350" },
          },
        },
        syncProofs: [
          {
            scopeKey: "dm-1",
            proofKind: "latest_messages",
            status: "complete",
            coverage: { latestMessageId: "350" },
            resumeCursor: null,
            lastObservedAt: 100,
          },
          {
            scopeKey: "dm-1",
            proofKind: "messages",
            status: "running",
            coverage: { oldestMessageId: "250", newestMessageId: "350" },
            resumeCursor: { before: "250" },
            lastObservedAt: 100,
          },
        ],
      },
    );

    expect(fetchedRequests).toEqual([{ channelId: "dm-1", before: "250", limit: 100 }]);
    expect(bundle.rawEvents.filter((event) => event.entityKind === "message")).toHaveLength(0);
    expect(bundle.diagnostics?.discordBackfill).toEqual({
      selectedChannelCount: 1,
      attemptedChannelCount: 1,
      completedChannelCount: 0,
      messageLimitPerChannel: 100,
      partial: true,
      breakChannelId: "dm-1",
      error: "Discord backfill cursor did not advance before '250'",
      rateLimited: false,
      retryAfterMs: null,
    });
    expect(findDiscordProof(bundle, "conversation", "dm-1", "messages")).toEqual(
      expect.objectContaining({
        status: "failed",
        resumeCursor: {
          before: "250",
        },
        error: {
          message: "Discord backfill cursor did not advance before '250'",
          retryAfterMs: null,
          rateLimited: false,
        },
      }),
    );
    expect(bundle.hasMore).toBe(false);
  });

  it("bounds latest-message pagination when Discord repeats the same page", async () => {
    const fetchedRequests: Array<{ channelId: string; before?: string | null; limit?: number }> =
      [];

    const bundle = await buildDiscordSyncBundle(
      { accountKey: "default" },
      {
        syncMessageChannelLimit: 0,
        client: {
          async getCurrentUser() {
            return {
              id: "u-self",
              username: "avery",
              global_name: "Avery",
            };
          },
          async listPrivateChannels() {
            return [
              {
                id: "dm-1",
                type: 1,
                recipients: [{ id: "u-1", username: "ava" }],
                last_message_id: "350",
              },
            ];
          },
          async listChannelMessages(
            channelId: string,
            options?: { before?: string | null; limit?: number },
          ) {
            fetchedRequests.push({
              channelId,
              before: options?.before,
              limit: options?.limit,
            });
            return buildDescendingDiscordMessages(channelId, 350, 251);
          },
        } as unknown as DiscordApiClient,
        sourceCursor: {
          userId: "u-self",
          discoveredAt: 1_710_000_000_000,
          lastSyncAt: 1_710_000_000_000,
          channels: {
            "dm-1": { latestMessageId: "150" },
          },
        },
        syncProofs: [
          {
            scopeKey: "dm-1",
            proofKind: "latest_messages",
            status: "complete",
            coverage: { latestMessageId: "150" },
            resumeCursor: null,
            lastObservedAt: 100,
          },
        ],
      },
    );

    expect(fetchedRequests).toEqual([
      { channelId: "dm-1", before: null, limit: 100 },
      { channelId: "dm-1", before: "251", limit: 100 },
    ]);
    expect(bundle.rawEvents.filter((event) => event.entityKind === "message")).toHaveLength(200);
    expect(bundle.hasMore).toBe(false);
  });
});

describe("discord sync limits", () => {
  it("allows zero to disable channel hydration and historical backfill", () => {
    process.env.CUED_DISCORD_SYNC_MESSAGE_CHANNEL_LIMIT = "0";
    process.env.CUED_DISCORD_SYNC_BACKFILL_PAGE_LIMIT = "0";

    expect(getDiscordSyncMessageChannelLimit()).toBe(0);
    expect(getDiscordSyncBackfillPageLimit()).toBe(0);
  });

  it("keeps per-channel message hydration positive", () => {
    process.env.CUED_DISCORD_SYNC_MESSAGES_PER_CHANNEL_LIMIT = "0";

    expect(getDiscordSyncMessagesPerChannelLimit()).toBe(50);
  });
});

function findDiscordProof(
  bundle: Awaited<ReturnType<typeof buildDiscordSyncBundle>>,
  scopeKind: string,
  scopeKey: string,
  proofKind: string,
) {
  return bundle.proofs?.find(
    (proof) =>
      proof.scope.kind === scopeKind &&
      proof.scope.key === scopeKey &&
      proof.proofKind === proofKind,
  );
}

function buildDescendingDiscordMessages(channelId: string, high: number, low: number) {
  const messages = [];
  for (let id = high; id >= low; id -= 1) {
    messages.push({
      id: String(id),
      channel_id: channelId,
      author: {
        id: `sender-${channelId}`,
        username: `user-${channelId}`,
      },
      content: `message-${id}`,
      timestamp: "2026-04-18T12:00:00.000Z",
    });
  }
  return messages;
}
