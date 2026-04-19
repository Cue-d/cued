import { describe, expect, it } from "vitest";
import type { DiscordApiClient } from "../api/client.js";
import { buildDiscordSyncBundle } from "./bundle.js";

describe("buildDiscordSyncBundle", () => {
  it("hydrates only the most recent DM messages during sync", async () => {
    const hydratedChannelIds: string[] = [];

    const bundle = await buildDiscordSyncBundle(
      { accountKey: "default" },
      {
        syncMessageChannelLimit: 2,
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
          async listChannelMessages(channelId: string) {
            hydratedChannelIds.push(channelId);
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

    expect(hydratedChannelIds).toEqual(["dm-2", "dm-3"]);
    expect(bundle.rawEvents.filter((event) => event.entityKind === "message")).toHaveLength(2);
    expect(
      bundle.rawEvents
        .filter((event) => event.entityKind === "message")
        .map((event) => (event.payload as { sourceConversationKey: string }).sourceConversationKey),
    ).toEqual(["discord:channel:dm-2", "discord:channel:dm-3"]);
  });
});
