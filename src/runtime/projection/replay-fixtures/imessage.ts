import { expect } from "vitest";
import type { ProjectionReplayFixture } from "./shared.js";
import { fixtureEvent } from "./shared.js";

export const imessageReplayFixtures: ProjectionReplayFixture[] = [
  {
    name: "imessage-dm-contact-arrives-late",
    assert(snapshot) {
      expect(snapshot.contacts).toHaveLength(1);
      expect(snapshot.contacts[0]?.name).toBe("Ava Chen");
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
        id: "imessage_conversation_dm_late_contact",
        platform: "imessage",
        accountKey: "local",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: 1_710_200_000_000,
        dedupeKey: "imessage:conversation:42:100",
        payload: {
          sourceConversationKey: "42",
          conversationType: "dm",
          displayName: null,
          nativeConversationKey: "chat-42",
          participants: [{ sourceEntityKey: "imessage:+15551230000" }],
        },
        sourceVersion: "imessage-v1",
      }),
      fixtureEvent({
        id: "imessage_message_dm_late_contact",
        platform: "imessage",
        accountKey: "local",
        entityKind: "message",
        eventKind: "created",
        externalEntityId: "imessage-guid-1",
        conversationExternalId: "42",
        occurredAt: 1_710_199_999_500,
        observedAt: 1_710_200_000_050,
        dedupeKey: "imessage:message:imessage-guid-1",
        payload: {
          sourceMessageKey: "imessage-guid-1",
          sourceConversationKey: "42",
          senderSourceKey: "imessage:+15551230000",
          sentAt: 1_710_199_999_500,
          content: "late contact should still resolve",
          service: "iMessage",
          status: "delivered",
          isFromMe: false,
          readAt: null,
          isEdited: false,
          isDeleted: false,
          attachments: [],
        },
        sourceVersion: "imessage-v1",
      }),
      fixtureEvent({
        id: "imessage_contact_dm_late_contact",
        platform: "imessage",
        accountKey: "local",
        entityKind: "contact",
        eventKind: "observed",
        externalEntityId: "101",
        observedAt: 1_710_200_000_100,
        dedupeKey: "imessage:contact:101:+15551230000",
        payload: {
          sourceEntityKey: "imessage:+15551230000",
          fields: {
            display_name: "Ava Chen",
          },
          handles: [
            {
              type: "phone",
              value: "+15551230000",
              deterministic: true,
            },
            {
              type: "imessage_handle",
              value: "+15551230000",
              deterministic: true,
            },
          ],
        },
        sourceVersion: "imessage-v1",
      }),
    ],
  },
  {
    name: "imessage-attachment-projection",
    assert(snapshot) {
      expect(snapshot.contacts).toHaveLength(1);
      expect(snapshot.contacts[0]?.name).toBe("Ava Email");
      expect(snapshot.conversations[0]).toMatchObject({
        name: "Ava Email",
        participantNames: "Ava Email",
      });
      expect(snapshot.messages[0]).toMatchObject({
        senderName: "Ava Email",
        attachmentCount: 1,
      });
      expect(snapshot.messageAttachments[0]).toMatchObject({
        filename: "agenda.pdf",
        localPath: "/Users/test/Library/Messages/Attachments/agenda.pdf",
        availabilityStatus: "available",
      });
    },
    events: [
      fixtureEvent({
        id: "imessage_contact_attachment",
        platform: "imessage",
        accountKey: "local",
        entityKind: "contact",
        eventKind: "observed",
        externalEntityId: "202",
        observedAt: 1_710_210_000_000,
        dedupeKey: "imessage:contact:202:ava@example.com",
        payload: {
          sourceEntityKey: "imessage:ava@example.com",
          fields: {
            display_name: "Ava Email",
          },
          handles: [
            {
              type: "email",
              value: "ava@example.com",
              deterministic: true,
            },
            {
              type: "imessage_handle",
              value: "ava@example.com",
              deterministic: true,
            },
          ],
        },
        sourceVersion: "imessage-v1",
      }),
      fixtureEvent({
        id: "imessage_conversation_attachment",
        platform: "imessage",
        accountKey: "local",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: 1_710_210_000_010,
        dedupeKey: "imessage:conversation:84:200",
        payload: {
          sourceConversationKey: "84",
          conversationType: "dm",
          displayName: null,
          nativeConversationKey: "chat-84",
          participants: [{ sourceEntityKey: "imessage:ava@example.com" }],
        },
        sourceVersion: "imessage-v1",
      }),
      fixtureEvent({
        id: "imessage_message_attachment",
        platform: "imessage",
        accountKey: "local",
        entityKind: "message",
        eventKind: "created",
        externalEntityId: "imessage-guid-attachment",
        conversationExternalId: "84",
        occurredAt: 1_710_210_000_020,
        observedAt: 1_710_210_000_020,
        dedupeKey: "imessage:message:imessage-guid-attachment",
        payload: {
          sourceMessageKey: "imessage-guid-attachment",
          sourceConversationKey: "84",
          senderSourceKey: "imessage:ava@example.com",
          sentAt: 1_710_210_000_020,
          content: "see attached",
          service: "iMessage",
          status: "delivered",
          isFromMe: false,
          readAt: null,
          isEdited: false,
          isDeleted: false,
          attachments: [
            {
              id: "attachment-guid-1",
              kind: "file",
              filename: "agenda.pdf",
              local_path: "/Users/test/Library/Messages/Attachments/agenda.pdf",
              mime_type: "application/pdf",
              size_bytes: 4096,
              access_kind: "local_path",
              availability_status: "available",
              access_ref: {
                path: "/Users/test/Library/Messages/Attachments/agenda.pdf",
              },
              provider_metadata: {
                uti: "com.adobe.pdf",
                isSticker: false,
                hideAttachment: false,
                ckRecordId: null,
                sourceFilename: "/Users/test/Library/Messages/Attachments/agenda.pdf",
              },
            },
          ],
        },
        sourceVersion: "imessage-v1",
      }),
    ],
  },
  {
    name: "imessage-reaction-name-catchup",
    assert(snapshot) {
      expect(snapshot.contacts.map((contact) => contact.name).sort()).toEqual([
        "Avery Example",
        "Jordan Example",
      ]);
      expect(snapshot.conversations[0]).toMatchObject({
        name: "Family",
        participantNames: "Avery Example | Jordan Example",
      });
      expect(snapshot.messages[0]).toMatchObject({
        senderName: "Avery Example",
        conversationName: "Family",
        reactionCount: 1,
      });
      expect(snapshot.messageReactions[0]).toMatchObject({
        emoji: "❤️",
        reactorName: "Jordan Example",
        isActive: 1,
      });
    },
    events: [
      fixtureEvent({
        id: "imessage_conversation_reaction",
        platform: "imessage",
        accountKey: "local",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: 1_710_220_000_000,
        dedupeKey: "imessage:conversation:126:300",
        payload: {
          sourceConversationKey: "126",
          conversationType: "group",
          displayName: "Family",
          nativeConversationKey: "chat-126",
          participants: [
            { sourceEntityKey: "imessage:+15550000001" },
            { sourceEntityKey: "imessage:+15550000002" },
          ],
        },
        sourceVersion: "imessage-v1",
      }),
      fixtureEvent({
        id: "imessage_message_reaction",
        platform: "imessage",
        accountKey: "local",
        entityKind: "message",
        eventKind: "created",
        externalEntityId: "imessage-guid-reaction",
        conversationExternalId: "126",
        occurredAt: 1_710_220_000_010,
        observedAt: 1_710_220_000_010,
        dedupeKey: "imessage:message:imessage-guid-reaction",
        payload: {
          sourceMessageKey: "imessage-guid-reaction",
          sourceConversationKey: "126",
          senderSourceKey: "imessage:+15550000001",
          sentAt: 1_710_220_000_010,
          content: "dinner at 7?",
          service: "iMessage",
          status: "delivered",
          isFromMe: false,
          readAt: null,
          isEdited: false,
          isDeleted: false,
          attachments: [],
        },
        sourceVersion: "imessage-v1",
      }),
      fixtureEvent({
        id: "imessage_reaction_added",
        platform: "imessage",
        accountKey: "local",
        entityKind: "reaction",
        eventKind: "added",
        externalEntityId: "imessage-guid-reaction:+15550000002:heart",
        conversationExternalId: "126",
        occurredAt: 1_710_220_000_015,
        observedAt: 1_710_220_000_015,
        dedupeKey: "imessage:reaction:imessage-guid-reaction:+15550000002:heart:1710220000015",
        payload: {
          sourceMessageKey: "imessage-guid-reaction",
          sourceConversationKey: "126",
          reactorSourceKey: "imessage:+15550000002",
          emoji: "❤️",
          timestamp: 1_710_220_000_015,
          isActive: true,
        },
        sourceVersion: "imessage-v1",
      }),
      fixtureEvent({
        id: "imessage_contact_sender",
        platform: "imessage",
        accountKey: "local",
        entityKind: "contact",
        eventKind: "observed",
        externalEntityId: "301",
        observedAt: 1_710_220_000_020,
        dedupeKey: "imessage:contact:301:+15550000001",
        payload: {
          sourceEntityKey: "imessage:+15550000001",
          fields: {
            display_name: "Avery Example",
          },
          handles: [
            { type: "phone", value: "+15550000001", deterministic: true },
            { type: "imessage_handle", value: "+15550000001", deterministic: true },
          ],
        },
        sourceVersion: "imessage-v1",
      }),
      fixtureEvent({
        id: "imessage_contact_reactor",
        platform: "imessage",
        accountKey: "local",
        entityKind: "contact",
        eventKind: "observed",
        externalEntityId: "302",
        observedAt: 1_710_220_000_030,
        dedupeKey: "imessage:contact:302:+15550000002",
        payload: {
          sourceEntityKey: "imessage:+15550000002",
          fields: {
            display_name: "Jordan Example",
          },
          handles: [
            { type: "phone", value: "+15550000002", deterministic: true },
            { type: "imessage_handle", value: "+15550000002", deterministic: true },
          ],
        },
        sourceVersion: "imessage-v1",
      }),
    ],
  },
];
