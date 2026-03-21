import {
  buildNormalizedRawEventSchema,
  type ProviderRawEventInput,
} from "../../core/types/provider.js";

export type ProjectionReplayFixture = {
  name: string;
  events: ProviderRawEventInput[];
};

function fixtureEvent(input: ProviderRawEventInput): ProviderRawEventInput {
  return {
    ...input,
    normalizedSchema: buildNormalizedRawEventSchema(input.entityKind, input.eventKind),
    provenance: {
      sourceVersion: input.sourceVersion ?? null,
      adapterVersion: "projection-replay-fixture@1",
    },
  };
}

export const replayFixtures: ProjectionReplayFixture[] = [
  {
    name: "contact-thread-message-reaction",
    events: [
      fixtureEvent({
        id: "contact_ava",
        platform: "contacts",
        accountKey: "local",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: 1_710_000_000_000,
        dedupeKey: "contacts:ava",
        payload: {
          sourceEntityKey: "contacts:ava",
          fields: {
            display_name: "Ava Chen",
            photo_url: "https://example.com/ava.png",
            company: "Cued",
          },
          handles: [
            { type: "email", value: "ava@cued.com", deterministic: true },
            { type: "phone", value: "+1 (555) 123-4567", deterministic: true },
          ],
        },
        sourceVersion: "contacts-v1",
      }),
      fixtureEvent({
        id: "conversation_thread_1",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: 1_710_000_000_100,
        dedupeKey: "linkedin:thread-1",
        payload: {
          sourceConversationKey: "thread-1",
          conversationType: "dm",
          service: "linkedin",
          participants: [{ sourceEntityKey: "contacts:ava" }],
        },
        sourceVersion: "linkedin-v1",
      }),
      fixtureEvent({
        id: "message_msg_1",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "message",
        eventKind: "message_created",
        observedAt: 1_710_000_000_200,
        dedupeKey: "linkedin:msg-1",
        payload: {
          sourceMessageKey: "msg-1",
          sourceConversationKey: "thread-1",
          senderSourceKey: "contacts:ava",
          sentAt: 1_710_000_000_150,
          content: "Founder update tomorrow?",
          service: "linkedin",
          status: "delivered",
          isFromMe: false,
          attachments: [
            {
              sourceAttachmentKey: "linkedin:msg-1:file",
              id: "linkedin:file:1",
              kind: "file",
              filename: "update.pdf",
              title: "Update",
              remote_url: "https://example.com/update.pdf",
              availability_status: "available",
            },
          ],
        },
        sourceVersion: "linkedin-v1",
      }),
      fixtureEvent({
        id: "reaction_msg_1_thumbs_up",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "reaction",
        eventKind: "created",
        observedAt: 1_710_000_000_300,
        dedupeKey: "linkedin:msg-1:thumbs-up",
        payload: {
          sourceMessageKey: "msg-1",
          sourceConversationKey: "thread-1",
          reactorSourceKey: "contacts:ava",
          emoji: "👍",
          timestamp: 1_710_000_000_250,
          isActive: true,
        },
        sourceVersion: "linkedin-v1",
      }),
    ],
  },
  {
    name: "out-of-order-slack-dm",
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
];
