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
  });
});
