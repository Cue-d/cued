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
        unreadCount: 1,
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
          service: "slack",
          participants: [{ sourceEntityKey: "slack:T0A9C9RHZ9T:U123" }],
        },
        sourceVersion: "slack-v1",
      }),
      fixtureEvent({
        id: "slack_message_before_contact",
        platform: "slack",
        accountKey: "T0A9C9RHZ9T",
        entityKind: "message",
        eventKind: "message_created",
        observedAt: 1_710_100_000_000,
        dedupeKey: "slack:message:C123:1",
        payload: {
          sourceMessageKey: "slack:T0A9C9RHZ9T:C123:1710100000.000100",
          sourceConversationKey: "slack:T0A9C9RHZ9T:C123",
          senderSourceKey: "slack:T0A9C9RHZ9T:U123",
          sentAt: 1_710_099_999_500,
          content: "hello from slack",
          service: "slack",
          isFromMe: false,
        },
        sourceVersion: "slack-v1",
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
        sourceVersion: "slack-v1",
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
        unreadCount: 2,
      });
      expect(snapshot.messages).toHaveLength(2);
      const reply = snapshot.messages.find(
        (message) => message.content === "Uploaded the latest file.",
      );
      expect(reply).toMatchObject({
        senderName: "Jordan Slack",
        attachmentCount: 1,
      });
      expect(reply?.replyToMessageId).toBeTruthy();
      expect(snapshot.messageAttachments[0]).toMatchObject({
        filename: "deck.pdf",
        remoteUrl: "https://files.example.com/deck.pdf",
        availabilityStatus: "available",
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
          service: "slack",
          participants: [{ sourceEntityKey: "slack:T0A9C9RHZ9T:U777" }],
        },
        sourceVersion: "slack-v1",
      }),
      fixtureEvent({
        id: "slack_thread_parent",
        platform: "slack",
        accountKey: "T0A9C9RHZ9T",
        entityKind: "message",
        eventKind: "message_created",
        observedAt: 1_710_200_000_100,
        dedupeKey: "slack:message:C777:parent",
        payload: {
          sourceMessageKey: "slack:T0A9C9RHZ9T:C777:1710200000.000100",
          sourceConversationKey: "slack:T0A9C9RHZ9T:C777",
          senderSourceKey: "slack:T0A9C9RHZ9T:U777",
          sentAt: 1_710_200_000_050,
          content: "Can you review the deck?",
          service: "slack",
          isFromMe: false,
        },
        sourceVersion: "slack-v1",
      }),
      fixtureEvent({
        id: "slack_thread_reply",
        platform: "slack",
        accountKey: "T0A9C9RHZ9T",
        entityKind: "message",
        eventKind: "message_created",
        observedAt: 1_710_200_000_200,
        dedupeKey: "slack:message:C777:reply",
        payload: {
          sourceMessageKey: "slack:T0A9C9RHZ9T:C777:1710200001.000200",
          sourceConversationKey: "slack:T0A9C9RHZ9T:C777",
          senderSourceKey: "slack:T0A9C9RHZ9T:U777",
          sentAt: 1_710_200_000_150,
          content: "Uploaded the latest file.",
          service: "slack",
          isFromMe: false,
          replyToSourceMessageKey: "slack:T0A9C9RHZ9T:C777:1710200000.000100",
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
              preview_ref: { url: "https://files.example.com/deck-thumb.png" },
              availability_status: "available",
              provider_metadata: {
                id: "F777",
                prettyType: "PDF",
              },
            },
          ],
        },
        sourceVersion: "slack-v1",
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
        sourceVersion: "slack-v1",
      }),
    ],
  },
];
