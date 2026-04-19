import { describe, expect, it } from "vitest";
import type { DiscordApiClient } from "../api/client.js";
import { buildDiscordSyncBundle } from "./bundle.js";

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
              username: "theo",
              global_name: "Theo",
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
              username: "theo",
              global_name: "Theo",
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
      },
    });
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
              username: "theo",
              global_name: "Theo",
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
  });
});

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
