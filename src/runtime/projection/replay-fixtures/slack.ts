import { expect } from "vitest";
import type { ProjectionReplayFixture } from "./shared.js";
import { fixtureEvent } from "./shared.js";

export const slackReplayFixtures: ProjectionReplayFixture[] = [
  {
    name: "out-of-order-slack-dm",
    assert(snapshot) {
      expect(snapshot.contacts).toHaveLength(1);
      expect(snapshot.contacts[0]?.name).toBe("Slack User");
      expect(snapshot.conversations).toHaveLength(1);
      expect(snapshot.conversations[0]).toMatchObject({
        name: "Slack User",
        participantNames: "Slack User",
      });
      expect(snapshot.messages).toHaveLength(1);
      expect(snapshot.messages[0]).toMatchObject({
        senderName: "Slack User",
        conversationName: "Slack User",
      });
    },
    events: [
      fixtureEvent({
        id: "slack_conversation_before_contact",
        platform: "slack",
        accountKey: "T0A9C9RHZ9T",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: 1_710_100_000_000,
        dedupeKey: "slack:conversation:C123",
        payload: {
          sourceConversationKey: "slack:T0A9C9RHZ9T:C123",
          conversationType: "dm",
          participants: [{ sourceEntityKey: "slack:T0A9C9RHZ9T:U123" }],
        },
      }),
      fixtureEvent({
        id: "slack_message_before_contact",
        platform: "slack",
        accountKey: "T0A9C9RHZ9T",
        entityKind: "message",
        eventKind: "created",
        observedAt: 1_710_100_000_000,
        dedupeKey: "slack:message:C123:1",
        payload: {
          sourceMessageKey: "slack:T0A9C9RHZ9T:C123:1710100000.000100",
          sourceConversationKey: "slack:T0A9C9RHZ9T:C123",
          senderSourceKey: "slack:T0A9C9RHZ9T:U123",
          sentAt: 1_710_099_999_500,
          content: "hello from slack",
          isFromMe: false,
        },
      }),
      fixtureEvent({
        id: "slack_contact_after",
        platform: "slack",
        accountKey: "T0A9C9RHZ9T",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: 1_710_100_000_000,
        dedupeKey: "slack:contact:U123",
        payload: {
          sourceEntityKey: "slack:T0A9C9RHZ9T:U123",
          fields: {
            display_name: "Slack User",
          },
          handles: [{ type: "slack_user", value: "U123", deterministic: true }],
        },
      }),
    ],
  },
  {
    name: "slack-thread-reply-with-attachment",
    assert(snapshot) {
      expect(snapshot.contacts).toHaveLength(1);
      expect(snapshot.contacts[0]?.name).toBe("Jordan Slack");
      expect(snapshot.conversations).toHaveLength(1);
      expect(snapshot.conversations[0]).toMatchObject({
        name: "Jordan Slack",
      });
      expect(snapshot.messages).toHaveLength(2);
      const reply = snapshot.messages.find(
        (message) => message.content === "Uploaded the latest file.",
      );
      expect(reply).toMatchObject({
        senderName: "Jordan Slack",
      });
      expect(snapshot.messageAttachments[0]).toMatchObject({
        filename: "deck.pdf",
        remoteUrl: "https://files.example.com/deck.pdf",
      });
    },
    events: [
      fixtureEvent({
        id: "slack_thread_conversation",
        platform: "slack",
        accountKey: "T0A9C9RHZ9T",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: 1_710_200_000_000,
        dedupeKey: "slack:conversation:C777",
        payload: {
          sourceConversationKey: "slack:T0A9C9RHZ9T:C777",
          conversationType: "dm",
          participants: [{ sourceEntityKey: "slack:T0A9C9RHZ9T:U777" }],
        },
      }),
      fixtureEvent({
        id: "slack_thread_parent",
        platform: "slack",
        accountKey: "T0A9C9RHZ9T",
        entityKind: "message",
        eventKind: "created",
        observedAt: 1_710_200_000_100,
        dedupeKey: "slack:message:C777:parent",
        payload: {
          sourceMessageKey: "slack:T0A9C9RHZ9T:C777:1710200000.000100",
          sourceConversationKey: "slack:T0A9C9RHZ9T:C777",
          senderSourceKey: "slack:T0A9C9RHZ9T:U777",
          sentAt: 1_710_200_000_050,
          content: "Can you review the deck?",
          isFromMe: false,
        },
      }),
      fixtureEvent({
        id: "slack_thread_reply",
        platform: "slack",
        accountKey: "T0A9C9RHZ9T",
        entityKind: "message",
        eventKind: "created",
        observedAt: 1_710_200_000_200,
        dedupeKey: "slack:message:C777:reply",
        payload: {
          sourceMessageKey: "slack:T0A9C9RHZ9T:C777:1710200001.000200",
          sourceConversationKey: "slack:T0A9C9RHZ9T:C777",
          senderSourceKey: "slack:T0A9C9RHZ9T:U777",
          sentAt: 1_710_200_000_150,
          content: "Uploaded the latest file.",
          isFromMe: false,
          attachments: [
            {
              kind: "file",
              id: "F777",
              name: "deck.pdf",
              mimetype: "application/pdf",
              size: 4096,
              url: "https://files.example.com/deck.pdf",
              previewUrl: "https://files.example.com/deck-thumb.png",
              access_kind: "remote_url",
              access_ref: { url: "https://files.example.com/deck.pdf" },
            },
          ],
        },
      }),
      fixtureEvent({
        id: "slack_thread_contact_after",
        platform: "slack",
        accountKey: "T0A9C9RHZ9T",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: 1_710_200_000_300,
        dedupeKey: "slack:contact:U777",
        payload: {
          sourceEntityKey: "slack:T0A9C9RHZ9T:U777",
          fields: {
            display_name: "Jordan Slack",
          },
          handles: [{ type: "slack_user", value: "U777", deterministic: true }],
        },
      }),
    ],
  },
];
