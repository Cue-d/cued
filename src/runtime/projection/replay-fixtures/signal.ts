import { expect } from "vitest";
import type { ProjectionReplayFixture } from "./shared.js";
import { fixtureEvent } from "./shared.js";

export const signalReplayFixtures: ProjectionReplayFixture[] = [
  {
    name: "signal-out-of-order-contact-message",
    assert(snapshot) {
      expect(snapshot.contacts).toHaveLength(1);
      expect(snapshot.contacts[0]?.name).toBe("Casey Signal");
      expect(snapshot.conversations[0]).toMatchObject({
        name: "Casey Signal",
        participantNames: "Casey Signal",
      });
      expect(snapshot.messages[0]).toMatchObject({
        senderName: "Casey Signal",
        conversationName: "Casey Signal",
      });
    },
    events: [
      fixtureEvent({
        id: "signal-conversation-before-contact",
        platform: "signal",
        accountKey: "default",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: 1_710_200_000_000,
        dedupeKey: "signal:conversation:dm-casey",
        payload: {
          sourceConversationKey: "signal:dm-casey",
          conversationType: "dm",
          displayName: "Casey Signal",
          service: "signal",
          participants: [{ sourceEntityKey: "signal:+14155550123" }],
        },
        sourceVersion: "signal-v1",
      }),
      fixtureEvent({
        id: "signal-message-before-contact",
        platform: "signal",
        accountKey: "default",
        entityKind: "message",
        eventKind: "created",
        observedAt: 1_710_200_000_100,
        dedupeKey: "signal:message:casey-1",
        payload: {
          sourceMessageKey: "signal:message:casey-1",
          sourceConversationKey: "signal:dm-casey",
          senderSourceKey: "signal:+14155550123",
          sentAt: 1_710_200_000_050,
          content: "hello from signal",
          service: "signal",
          isFromMe: false,
        },
        sourceVersion: "signal-v1",
      }),
      fixtureEvent({
        id: "signal-contact-after",
        platform: "signal",
        accountKey: "default",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: 1_710_200_000_200,
        dedupeKey: "signal:contact:+14155550123",
        payload: {
          sourceEntityKey: "signal:+14155550123",
          fields: { display_name: "Casey Signal" },
          handles: [{ type: "phone", value: "+14155550123", deterministic: true }],
        },
        sourceVersion: "signal-v1",
      }),
    ],
  },
  {
    name: "signal-reply-attachment-rename",
    assert(snapshot) {
      expect(snapshot.contacts).toHaveLength(1);
      expect(snapshot.contacts[0]?.name).toBe("Ava Zhang");
      expect(snapshot.conversations[0]).toMatchObject({
        name: "Investor thread",
        participantNames: "Ava Zhang",
        unreadCount: 2,
      });
      expect(snapshot.messages).toHaveLength(2);
      const reply = snapshot.messages.find((message) => message.content === "reply first");
      expect(reply).toMatchObject({
        senderName: "Ava Zhang",
        conversationName: "Investor thread",
        attachmentCount: 1,
      });
      expect(reply?.replyToMessageId).toBeTruthy();
      expect(snapshot.messageAttachments[0]).toMatchObject({
        filename: "agenda.pdf",
        title: "Agenda",
        availabilityStatus: "metadata_only",
      });
    },
    events: [
      fixtureEvent({
        id: "signal-contact-ava",
        platform: "signal",
        accountKey: "default",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: 1_710_300_000_000,
        dedupeKey: "signal:contact:+14155550000",
        payload: {
          sourceEntityKey: "signal:+14155550000",
          fields: { display_name: "Ava Chen" },
          handles: [{ type: "phone", value: "+14155550000", deterministic: true }],
        },
        sourceVersion: "signal-v1",
      }),
      fixtureEvent({
        id: "signal-conversation-ava",
        platform: "signal",
        accountKey: "default",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: 1_710_300_000_100,
        dedupeKey: "signal:conversation:dm-ava",
        payload: {
          sourceConversationKey: "signal:dm-ava",
          conversationType: "dm",
          displayName: "Ava Chen",
          service: "signal",
          participants: [{ sourceEntityKey: "signal:+14155550000" }],
        },
        sourceVersion: "signal-v1",
      }),
      fixtureEvent({
        id: "signal-parent-message",
        platform: "signal",
        accountKey: "default",
        entityKind: "message",
        eventKind: "created",
        observedAt: 1_710_300_000_200,
        dedupeKey: "signal:message:parent",
        payload: {
          sourceMessageKey: "signal:message:parent",
          sourceConversationKey: "signal:dm-ava",
          senderSourceKey: "signal:+14155550000",
          sentAt: 1_710_300_000_100,
          content: "parent later",
          service: "signal",
          isFromMe: false,
        },
        sourceVersion: "signal-v1",
      }),
      fixtureEvent({
        id: "signal-reply-message",
        platform: "signal",
        accountKey: "default",
        entityKind: "message",
        eventKind: "created",
        observedAt: 1_710_300_000_300,
        dedupeKey: "signal:message:reply",
        payload: {
          sourceMessageKey: "signal:message:reply",
          sourceConversationKey: "signal:dm-ava",
          senderSourceKey: "signal:+14155550000",
          sentAt: 1_710_300_000_150,
          content: "reply first",
          service: "signal",
          isFromMe: false,
          replyToSourceMessageKey: "signal:message:parent",
          attachments: [
            {
              id: "signal-attachment-1",
              filename: "agenda.pdf",
              title: "Agenda",
              text: "Board agenda",
            },
          ],
        },
        sourceVersion: "signal-v1",
      }),
      fixtureEvent({
        id: "signal-contact-ava-rename",
        platform: "signal",
        accountKey: "default",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: 1_710_300_000_400,
        dedupeKey: "signal:contact:+14155550000:rename",
        payload: {
          sourceEntityKey: "signal:+14155550000",
          fields: { display_name: "Ava Zhang" },
          handles: [{ type: "phone", value: "+14155550000", deterministic: true }],
        },
        sourceVersion: "signal-v2",
      }),
      fixtureEvent({
        id: "signal-conversation-ava-rename",
        platform: "signal",
        accountKey: "default",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: 1_710_300_000_500,
        dedupeKey: "signal:conversation:dm-ava:rename",
        payload: {
          sourceConversationKey: "signal:dm-ava",
          conversationType: "dm",
          displayName: "Investor thread",
          service: "signal",
          participants: [{ sourceEntityKey: "signal:+14155550000" }],
        },
        sourceVersion: "signal-v2",
      }),
    ],
  },
  {
    name: "signal-uuid-identity",
    assert(snapshot) {
      expect(snapshot.contacts).toHaveLength(1);
      expect(snapshot.contacts[0]?.name).toBe("a1b2c3d4-e5f6-1234-9abc-def012345678");
      expect(snapshot.conversations[0]).toMatchObject({
        name: "Ava Chen",
        participantNames: "Ava Chen",
      });
      expect(snapshot.messages[0]).toMatchObject({
        senderName: "Ava Chen",
        conversationName: "Ava Chen",
      });
    },
    events: [
      fixtureEvent({
        id: "signal-contact-uuid",
        platform: "signal",
        accountKey: "default",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: 1_710_400_000_000,
        dedupeKey: "signal:contact:uuid",
        payload: {
          sourceEntityKey: "signal:a1b2c3d4-e5f6-1234-9abc-def012345678",
          fields: { display_name: "a1b2c3d4-e5f6-1234-9abc-def012345678" },
          handles: [
            {
              type: "signal_id",
              value: "a1b2c3d4-e5f6-1234-9abc-def012345678",
              deterministic: true,
            },
          ],
        },
        sourceVersion: "signal-v1",
      }),
      fixtureEvent({
        id: "signal-conversation-uuid",
        platform: "signal",
        accountKey: "default",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: 1_710_400_000_100,
        dedupeKey: "signal:conversation:uuid",
        payload: {
          sourceConversationKey: "signal:dm-uuid",
          conversationType: "dm",
          displayName: "Ava Chen",
          service: "signal",
          participants: [{ sourceEntityKey: "signal:a1b2c3d4-e5f6-1234-9abc-def012345678" }],
        },
        sourceVersion: "signal-v1",
      }),
      fixtureEvent({
        id: "signal-message-uuid",
        platform: "signal",
        accountKey: "default",
        entityKind: "message",
        eventKind: "created",
        observedAt: 1_710_400_000_200,
        dedupeKey: "signal:message:uuid",
        payload: {
          sourceMessageKey: "signal:message:uuid",
          sourceConversationKey: "signal:dm-uuid",
          senderSourceKey: "signal:a1b2c3d4-e5f6-1234-9abc-def012345678",
          sentAt: 1_710_400_000_150,
          content: "hello from signal uuid",
          service: "signal",
          isFromMe: false,
        },
        sourceVersion: "signal-v1",
      }),
    ],
  },
];
