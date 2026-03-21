import { expect } from "vitest";
import {
  whatsappSourceConversationKey,
  whatsappSourceEntityKey,
} from "../../../platforms/whatsapp/sync/events.js";
import type { ProjectionReplayFixture } from "./shared.js";
import { fixtureEvent } from "./shared.js";

const dmPeer = "12016824050@s.whatsapp.net";
const studyGroup = "120363012345678901@g.us";
const studyGroupAlice = "15551234567@s.whatsapp.net";
const studyGroupBob = "15557654321@s.whatsapp.net";
const irene = "14155550123@s.whatsapp.net";

export const whatsappReplayFixtures: ProjectionReplayFixture[] = [
  {
    name: "whatsapp-dm-late-contact",
    assert(snapshot) {
      expect(snapshot.contacts).toHaveLength(1);
      expect(snapshot.contacts[0]?.name).toBe("Soham Bafana");
      expect(snapshot.conversations[0]).toMatchObject({
        name: "Soham Bafana",
        participantNames: "Soham Bafana",
      });
      expect(snapshot.messages[0]).toMatchObject({
        senderName: "Soham Bafana",
        conversationName: "Soham Bafana",
      });
    },
    events: [
      fixtureEvent({
        id: "whatsapp_dm_message_before_contact",
        platform: "whatsapp",
        accountKey: "default",
        entityKind: "message",
        eventKind: "message_created",
        observedAt: 1_713_000_000_100,
        dedupeKey: "whatsapp:dm:message:1",
        payload: {
          sourceMessageKey: `${dmPeer}:wamid-dm-1`,
          sourceConversationKey: whatsappSourceConversationKey(dmPeer),
          senderSourceKey: whatsappSourceEntityKey(dmPeer),
          sentAt: 1_713_000_000_000,
          content: "hello from WhatsApp",
          service: "whatsapp",
          status: "delivered",
          isFromMe: false,
        },
        sourceVersion: "whatsapp-v1",
      }),
      fixtureEvent({
        id: "whatsapp_dm_chat",
        platform: "whatsapp",
        accountKey: "default",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: 1_713_000_000_200,
        dedupeKey: "whatsapp:dm:chat:1",
        payload: {
          sourceConversationKey: whatsappSourceConversationKey(dmPeer),
          conversationType: "dm",
          displayName: null,
          nativeConversationKey: dmPeer,
          service: "whatsapp",
          participants: [{ sourceEntityKey: whatsappSourceEntityKey(dmPeer) }],
        },
        sourceVersion: "whatsapp-v1",
      }),
      fixtureEvent({
        id: "whatsapp_dm_contact",
        platform: "whatsapp",
        accountKey: "default",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: 1_713_000_000_300,
        dedupeKey: "whatsapp:dm:contact:1",
        payload: {
          sourceEntityKey: whatsappSourceEntityKey(dmPeer),
          fields: {
            display_name: "Soham Bafana",
          },
          handles: [
            { type: "whatsapp_jid", value: dmPeer, deterministic: true },
            { type: "phone", value: "+12016824050", deterministic: true },
          ],
        },
        sourceVersion: "whatsapp-v1",
      }),
    ],
  },
  {
    name: "whatsapp-group-attachments-and-fromme",
    assert(snapshot) {
      expect(snapshot.contacts.map((contact) => contact.name).sort()).toEqual(["Alice", "Bob"]);
      expect(snapshot.conversations[0]).toMatchObject({
        name: "Study Group",
        unreadCount: 1,
      });
      expect(snapshot.messages).toHaveLength(2);
      const inbound = snapshot.messages.find((message) => message.content === "agenda attached");
      const outbound = snapshot.messages.find((message) => message.content === "thanks, got it");
      expect(inbound).toMatchObject({
        senderName: "Alice",
        conversationName: "Study Group",
        attachmentCount: 1,
        isFromMe: 0,
      });
      expect(outbound).toMatchObject({
        senderName: null,
        conversationName: "Study Group",
        isFromMe: 1,
      });
      expect(snapshot.messageAttachments[0]).toMatchObject({
        filename: "agenda.pdf",
        title: "Agenda",
        remoteUrl: "https://example.com/agenda.pdf",
        availabilityStatus: "available",
      });
    },
    events: [
      fixtureEvent({
        id: "whatsapp_group_chat",
        platform: "whatsapp",
        accountKey: "default",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: 1_713_010_000_000,
        dedupeKey: "whatsapp:group:chat:1",
        payload: {
          sourceConversationKey: whatsappSourceConversationKey(studyGroup),
          conversationType: "group",
          displayName: "Study Group",
          nativeConversationKey: studyGroup,
          service: "whatsapp",
          participants: [
            { sourceEntityKey: whatsappSourceEntityKey(studyGroupAlice) },
            { sourceEntityKey: whatsappSourceEntityKey(studyGroupBob) },
          ],
        },
        sourceVersion: "whatsapp-v1",
      }),
      fixtureEvent({
        id: "whatsapp_group_contact_alice",
        platform: "whatsapp",
        accountKey: "default",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: 1_713_010_000_100,
        dedupeKey: "whatsapp:group:contact:alice",
        payload: {
          sourceEntityKey: whatsappSourceEntityKey(studyGroupAlice),
          fields: {
            display_name: "Alice",
          },
          handles: [
            { type: "whatsapp_jid", value: studyGroupAlice, deterministic: true },
            { type: "phone", value: "+15551234567", deterministic: true },
          ],
        },
        sourceVersion: "whatsapp-v1",
      }),
      fixtureEvent({
        id: "whatsapp_group_contact_bob",
        platform: "whatsapp",
        accountKey: "default",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: 1_713_010_000_200,
        dedupeKey: "whatsapp:group:contact:bob",
        payload: {
          sourceEntityKey: whatsappSourceEntityKey(studyGroupBob),
          fields: {
            display_name: "Bob",
          },
          handles: [
            { type: "whatsapp_jid", value: studyGroupBob, deterministic: true },
            { type: "phone", value: "+15557654321", deterministic: true },
          ],
        },
        sourceVersion: "whatsapp-v1",
      }),
      fixtureEvent({
        id: "whatsapp_group_message_attachment",
        platform: "whatsapp",
        accountKey: "default",
        entityKind: "message",
        eventKind: "message_created",
        observedAt: 1_713_010_000_300,
        dedupeKey: "whatsapp:group:message:1",
        payload: {
          sourceMessageKey: `${studyGroup}:wamid-group-1`,
          sourceConversationKey: whatsappSourceConversationKey(studyGroup),
          senderSourceKey: whatsappSourceEntityKey(studyGroupAlice),
          sentAt: 1_713_010_000_250,
          content: "agenda attached",
          service: "whatsapp",
          status: "delivered",
          isFromMe: false,
          attachments: [
            {
              sourceAttachmentKey: "whatsapp:group:wamid-group-1:file",
              id: "whatsapp:group:file:1",
              kind: "file",
              filename: "agenda.pdf",
              title: "Agenda",
              remote_url: "https://example.com/agenda.pdf",
              availability_status: "available",
              mime_type: "application/pdf",
              size_bytes: 0,
              provider_metadata: {
                note: "meeting agenda",
              },
            },
          ],
        },
        sourceVersion: "whatsapp-v1",
      }),
      fixtureEvent({
        id: "whatsapp_group_message_fromme",
        platform: "whatsapp",
        accountKey: "default",
        entityKind: "message",
        eventKind: "message_created",
        observedAt: 1_713_010_000_400,
        dedupeKey: "whatsapp:group:message:2",
        payload: {
          sourceMessageKey: `${studyGroup}:wamid-group-2`,
          sourceConversationKey: whatsappSourceConversationKey(studyGroup),
          senderSourceKey: null,
          sentAt: 1_713_010_000_350,
          content: "thanks, got it",
          service: "whatsapp",
          status: "sent",
          isFromMe: true,
        },
        sourceVersion: "whatsapp-v1",
      }),
    ],
  },
  {
    name: "whatsapp-dm-fromme-reply",
    assert(snapshot) {
      expect(snapshot.contacts).toHaveLength(1);
      expect(snapshot.contacts[0]?.name).toBe("Irene");
      expect(snapshot.conversations[0]).toMatchObject({
        name: "Irene",
        unreadCount: 2,
      });
      expect(snapshot.messages).toHaveLength(3);
      const reply = snapshot.messages.find((message) => message.content === "on my way");
      expect(reply).toMatchObject({
        senderName: null,
        conversationName: "Irene",
        isFromMe: 1,
      });
      expect(reply?.replyToMessageId).toBeTruthy();
    },
    events: [
      fixtureEvent({
        id: "whatsapp_dm_fromme_chat",
        platform: "whatsapp",
        accountKey: "default",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: 1_713_020_000_000,
        dedupeKey: "whatsapp:dm:chat:2",
        payload: {
          sourceConversationKey: whatsappSourceConversationKey(irene),
          conversationType: "dm",
          displayName: null,
          nativeConversationKey: irene,
          service: "whatsapp",
          participants: [{ sourceEntityKey: whatsappSourceEntityKey(irene) }],
        },
        sourceVersion: "whatsapp-v1",
      }),
      fixtureEvent({
        id: "whatsapp_dm_fromme_parent_message",
        platform: "whatsapp",
        accountKey: "default",
        entityKind: "message",
        eventKind: "message_created",
        observedAt: 1_713_020_000_100,
        dedupeKey: "whatsapp:dm:message:parent",
        payload: {
          sourceMessageKey: `${irene}:wamid-dm-parent`,
          sourceConversationKey: whatsappSourceConversationKey(irene),
          senderSourceKey: whatsappSourceEntityKey(irene),
          sentAt: 1_713_020_000_025,
          content: "where are you?",
          service: "whatsapp",
          status: "delivered",
          isFromMe: false,
        },
        sourceVersion: "whatsapp-v1",
      }),
      fixtureEvent({
        id: "whatsapp_dm_fromme_reply_message",
        platform: "whatsapp",
        accountKey: "default",
        entityKind: "message",
        eventKind: "message_created",
        observedAt: 1_713_020_000_150,
        dedupeKey: "whatsapp:dm:message:fromme-reply",
        payload: {
          sourceMessageKey: `${irene}:wamid-dm-fromme`,
          sourceConversationKey: whatsappSourceConversationKey(irene),
          senderSourceKey: null,
          sentAt: 1_713_020_000_050,
          content: "on my way",
          service: "whatsapp",
          status: "sent",
          isFromMe: true,
          replyToSourceMessageKey: `${irene}:wamid-dm-parent`,
        },
        sourceVersion: "whatsapp-v1",
      }),
      fixtureEvent({
        id: "whatsapp_dm_fromme_contact",
        platform: "whatsapp",
        accountKey: "default",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: 1_713_020_000_200,
        dedupeKey: "whatsapp:dm:contact:2",
        payload: {
          sourceEntityKey: whatsappSourceEntityKey(irene),
          fields: {
            display_name: "Irene",
          },
          handles: [
            { type: "whatsapp_jid", value: irene, deterministic: true },
            { type: "phone", value: "+14155550123", deterministic: true },
          ],
        },
        sourceVersion: "whatsapp-v1",
      }),
      fixtureEvent({
        id: "whatsapp_dm_followup_message",
        platform: "whatsapp",
        accountKey: "default",
        entityKind: "message",
        eventKind: "message_created",
        observedAt: 1_713_020_000_300,
        dedupeKey: "whatsapp:dm:message:reply",
        payload: {
          sourceMessageKey: `${irene}:wamid-dm-reply`,
          sourceConversationKey: whatsappSourceConversationKey(irene),
          senderSourceKey: whatsappSourceEntityKey(irene),
          sentAt: 1_713_020_000_250,
          content: "see you soon",
          service: "whatsapp",
          status: "delivered",
          isFromMe: false,
        },
        sourceVersion: "whatsapp-v1",
      }),
    ],
  },
];
