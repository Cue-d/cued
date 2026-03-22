import { expect } from "vitest";
import type { ProjectionReplayFixture } from "./shared.js";
import { fixtureEvent } from "./shared.js";

export const contactsLinkedInReplayFixtures: ProjectionReplayFixture[] = [
  {
    name: "contact-thread-message-reaction",
    assert(snapshot) {
      expect(snapshot.contacts).toHaveLength(1);
      expect(snapshot.contacts[0]?.name).toBe("Ava Chen");
      expect(snapshot.conversations).toHaveLength(1);
      expect(snapshot.conversations[0]).toMatchObject({
        name: "Ava Chen",
        participantNames: "Ava Chen",
        unreadCount: 1,
      });
      expect(snapshot.messages).toHaveLength(1);
      expect(snapshot.messages[0]).toMatchObject({
        senderName: "Ava Chen",
        conversationName: "Ava Chen",
        attachmentCount: 1,
        reactionCount: 1,
      });
      expect(snapshot.messageAttachments[0]).toMatchObject({
        filename: "update.pdf",
        title: "Update",
        remoteUrl: "https://example.com/update.pdf",
        availabilityStatus: "available",
      });
      expect(snapshot.messageReactions[0]).toMatchObject({
        emoji: "👍",
        reactorName: "Ava Chen",
        isActive: 1,
      });
      expect(snapshot.ftsMessageIds).toEqual([snapshot.messages[0]!.id]);
    },
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
        eventKind: "created",
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
        eventKind: "added",
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
    name: "contact-thread-conversation-removed",
    assert(snapshot) {
      expect(snapshot.contacts).toHaveLength(1);
      expect(snapshot.contacts[0]?.name).toBe("Milo Grant");
      expect(snapshot.conversations).toHaveLength(1);
      expect(snapshot.conversations[0]).toMatchObject({
        name: "Northwind diligence",
        isActive: 0,
        unreadCount: 0,
      });
      expect(snapshot.messages).toHaveLength(1);
      expect(snapshot.messages[0]).toMatchObject({
        senderName: "Milo Grant",
        conversationName: "Northwind diligence",
      });
      expect(snapshot.conversationParticipants).toHaveLength(1);
      expect(snapshot.conversationParticipants[0]).toMatchObject({
        participantName: "Milo Grant",
        isSelf: 0,
        isActive: 0,
      });
    },
    events: [
      fixtureEvent({
        id: "contact_milo",
        platform: "contacts",
        accountKey: "local",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: 1_710_000_100_000,
        dedupeKey: "contacts:milo",
        payload: {
          sourceEntityKey: "contacts:milo",
          fields: {
            display_name: "Milo Grant",
            company: "Northwind Capital",
          },
          handles: [{ type: "email", value: "milo@northwind.example", deterministic: true }],
        },
        sourceVersion: "contacts-v1",
      }),
      fixtureEvent({
        id: "conversation_thread_removed",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: 1_710_000_100_100,
        dedupeKey: "linkedin:thread-removed",
        payload: {
          sourceConversationKey: "thread-removed",
          conversationType: "dm",
          displayName: "Northwind diligence",
          nativeConversationKey: "urn:li:fsd_conversation:thread-removed",
          service: "linkedin",
          participants: [{ sourceEntityKey: "contacts:milo" }],
        },
        sourceVersion: "linkedin-v1",
      }),
      fixtureEvent({
        id: "message_thread_removed_1",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "message",
        eventKind: "created",
        observedAt: 1_710_000_100_200,
        dedupeKey: "linkedin:thread-removed:msg-1",
        payload: {
          sourceMessageKey: "msg-removed-1",
          sourceConversationKey: "thread-removed",
          senderSourceKey: "contacts:milo",
          sentAt: 1_710_000_100_150,
          content: "We should archive this thread.",
          service: "linkedin",
          status: "delivered",
          isFromMe: false,
        },
        sourceVersion: "linkedin-v1",
      }),
      fixtureEvent({
        id: "conversation_thread_removed_deleted",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "conversation",
        eventKind: "removed",
        observedAt: 1_710_000_100_300,
        dedupeKey: "linkedin:thread-removed:deleted",
        payload: {
          sourceConversationKey: "thread-removed",
          conversationType: "dm",
          displayName: "Northwind diligence",
          nativeConversationKey: "urn:li:fsd_conversation:thread-removed",
          service: "linkedin",
          unreadCount: 0,
          participants: [{ sourceEntityKey: "contacts:milo" }],
        },
        sourceVersion: "linkedin-v1",
      }),
    ],
  },
  {
    name: "linkedin-message-update-read-receipt-reaction-removed-system-message",
    assert(snapshot) {
      expect(snapshot.contacts).toHaveLength(1);
      expect(snapshot.contacts[0]?.name).toBe("Ava Chen");
      expect(snapshot.conversations).toHaveLength(1);
      expect(snapshot.conversations[0]).toMatchObject({
        name: "Ava Chen",
        unreadCount: 0,
      });
      expect(snapshot.messages).toHaveLength(1);
      expect(snapshot.messages[0]).toMatchObject({
        content: "final copy",
        status: "read",
        readAt: 1_710_000_200_260,
        editedAt: 1_710_000_200_210,
        isEdited: 1,
        reactionCount: 0,
      });
      expect(snapshot.messageReactions).toHaveLength(1);
      expect(snapshot.messageReactions[0]).toMatchObject({
        emoji: "👍",
        isActive: 0,
      });
      expect(snapshot.timelineEvents).toHaveLength(1);
      expect(snapshot.timelineEvents[0]).toMatchObject({
        eventKind: "system_message",
        subjectSourceKey: "contacts:ava",
        text: "Ava renamed the conversation",
      });
    },
    events: [
      fixtureEvent({
        id: "contact_ava_updated",
        platform: "contacts",
        accountKey: "local",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: 1_710_000_200_000,
        dedupeKey: "contacts:ava:updated",
        payload: {
          sourceEntityKey: "contacts:ava",
          fields: {
            display_name: "Ava Chen",
          },
          handles: [{ type: "email", value: "ava@cued.com", deterministic: true }],
        },
        sourceVersion: "contacts-v1",
      }),
      fixtureEvent({
        id: "conversation_thread_updated",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: 1_710_000_200_050,
        dedupeKey: "linkedin:thread-updated",
        payload: {
          sourceConversationKey: "thread-updated",
          conversationType: "dm",
          service: "linkedin",
          participants: [{ sourceEntityKey: "contacts:ava" }],
        },
        sourceVersion: "linkedin-v1",
      }),
      fixtureEvent({
        id: "message_thread_updated_created",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "message",
        eventKind: "created",
        observedAt: 1_710_000_200_100,
        dedupeKey: "linkedin:thread-updated:msg-created",
        payload: {
          sourceMessageKey: "msg-updated",
          sourceConversationKey: "thread-updated",
          senderSourceKey: "contacts:ava",
          sentAt: 1_710_000_200_090,
          content: "draft copy",
          service: "linkedin",
          status: "delivered",
          isFromMe: false,
        },
        sourceVersion: "linkedin-v1",
      }),
      fixtureEvent({
        id: "message_thread_updated_updated",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "message",
        eventKind: "updated",
        observedAt: 1_710_000_200_220,
        dedupeKey: "linkedin:thread-updated:msg-updated",
        payload: {
          sourceMessageKey: "msg-updated",
          sourceConversationKey: "thread-updated",
          senderSourceKey: "contacts:ava",
          sentAt: 1_710_000_200_090,
          content: "final copy",
          service: "linkedin",
          status: "delivered",
          isFromMe: false,
          editedAt: 1_710_000_200_210,
          isEdited: true,
        },
        sourceVersion: "linkedin-v1",
      }),
      fixtureEvent({
        id: "reaction_thread_updated_added",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "reaction",
        eventKind: "added",
        observedAt: 1_710_000_200_230,
        dedupeKey: "linkedin:thread-updated:reaction-added",
        payload: {
          sourceMessageKey: "msg-updated",
          sourceConversationKey: "thread-updated",
          reactorSourceKey: "contacts:ava",
          emoji: "👍",
          timestamp: 1_710_000_200_225,
          isActive: true,
        },
        sourceVersion: "linkedin-v1",
      }),
      fixtureEvent({
        id: "reaction_thread_updated_removed",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "reaction",
        eventKind: "removed",
        observedAt: 1_710_000_200_240,
        dedupeKey: "linkedin:thread-updated:reaction-removed",
        payload: {
          sourceMessageKey: "msg-updated",
          sourceConversationKey: "thread-updated",
          reactorSourceKey: "contacts:ava",
          emoji: "👍",
          timestamp: 1_710_000_200_240,
          isActive: false,
        },
        sourceVersion: "linkedin-v1",
      }),
      fixtureEvent({
        id: "message_thread_updated_read_receipt",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "message",
        eventKind: "read_receipt",
        observedAt: 1_710_000_200_260,
        dedupeKey: "linkedin:thread-updated:read-receipt",
        payload: {
          sourceMessageKey: "msg-updated",
          sourceConversationKey: "thread-updated",
          senderSourceKey: "contacts:ava",
          sentAt: 1_710_000_200_090,
          content: "final copy",
          service: "linkedin",
          status: "read",
          isFromMe: false,
          readAt: 1_710_000_200_260,
          editedAt: 1_710_000_200_210,
          isEdited: true,
        },
        sourceVersion: "linkedin-v1",
      }),
      fixtureEvent({
        id: "timeline_thread_updated_system_message",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "timeline_event",
        eventKind: "system_message",
        observedAt: 1_710_000_200_280,
        dedupeKey: "linkedin:thread-updated:system-message",
        payload: {
          sourceEventKey: "timeline:thread-updated:system-message",
          sourceConversationKey: "thread-updated",
          eventKind: "system_message",
          actorSourceKey: "contacts:ava",
          subjectSourceKey: "contacts:ava",
          eventAt: 1_710_000_200_275,
          text: "Ava renamed the conversation",
          metadata: {
            systemKind: "provider_notice",
          },
        },
        sourceVersion: "linkedin-v1",
      }),
    ],
  },
];
