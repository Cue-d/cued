import { describe, expect, it } from "vitest";
import {
  buildDiscordConversationDisplayName,
  buildDiscordConversationEvent,
  buildDiscordMessageEvent,
} from "./events.js";

describe("discord sync events", () => {
  const currentUser = {
    id: "u-self",
    username: "avery",
    global_name: "Avery",
  };

  it("builds DM conversation names from recipients", () => {
    expect(
      buildDiscordConversationDisplayName(
        {
          id: "dm-1",
          type: 1,
          recipients: [
            {
              id: "u-peer",
              username: "ava",
              global_name: "Ava Chen",
            },
          ],
        },
        currentUser,
      ),
    ).toBe("Ava Chen");
  });

  it("builds group DM conversation events with a readable title", () => {
    const event = buildDiscordConversationEvent({
      accountKey: "default",
      observedAt: 1_710_000_000_000,
      channel: {
        id: "c-1",
        type: 3,
        name: "planning",
        topic: "Team chat",
        recipients: [
          {
            id: "u-peer",
            username: "ava",
            global_name: "Ava Chen",
          },
        ],
      },
      currentUser,
    });

    expect(event.payload).toMatchObject({
      sourceConversationKey: "discord:channel:c-1",
      displayName: "planning",
      conversationType: "group",
      topic: "Team chat",
    });
  });

  it("builds message events with reply and attachment metadata", () => {
    const event = buildDiscordMessageEvent({
      accountKey: "default",
      observedAt: 1_710_000_000_000,
      channel: {
        id: "c-1",
        type: 0,
      },
      currentUserId: "u-self",
      message: {
        id: "m-1",
        channel_id: "c-1",
        author: {
          id: "u-peer",
          username: "ava",
          global_name: "Ava Chen",
        },
        content: "hello",
        timestamp: "2024-03-01T12:00:00.000Z",
        edited_timestamp: "2024-03-01T12:01:00.000Z",
        message_reference: {
          channel_id: "c-1",
          message_id: "m-0",
        },
        attachments: [
          {
            id: "a-1",
            filename: "spec.pdf",
            content_type: "application/pdf",
            size: 42,
            url: "https://cdn/spec.pdf",
            proxy_url: "https://proxy/spec.pdf",
          },
        ],
      },
    });

    expect(event.payload).toMatchObject({
      sourceMessageKey: "discord:message:c-1:m-1",
      sourceConversationKey: "discord:channel:c-1",
      senderSourceKey: "discord:u-peer",
      isFromMe: false,
      isEdited: true,
      replyToSourceMessageKey: "discord:message:c-1:m-0",
    });
    const attachments = (event.payload as { attachments?: Array<Record<string, unknown>> })
      .attachments;
    expect(attachments?.[0]).toMatchObject({
      name: "spec.pdf",
      mimetype: "application/pdf",
      access_kind: "remote_url",
    });
  });
});
