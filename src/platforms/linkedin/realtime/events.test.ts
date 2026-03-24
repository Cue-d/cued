import { describe, expect, it } from "vitest";
import { buildLinkedInRawEventsFromRealtimeEnvelope } from "./events.js";

const selfParticipant = {
  entityURN: "urn:li:fsd_profile:SELF123",
  participantType: {
    member: {
      firstName: "Theo",
      lastName: "Tarr",
      profileUrl: "https://www.linkedin.com/in/theotarr",
    },
  },
};

const peerParticipant = {
  entityURN: "urn:li:fsd_profile:ACoAAA1",
  participantType: {
    member: {
      firstName: "Ava",
      lastName: "Chen",
      profileUrl: "https://www.linkedin.com/in/ava-chen",
    },
  },
};

describe("buildLinkedInRawEventsFromRealtimeEnvelope", () => {
  it("maps dm seen receipts onto message read updates", () => {
    const rawEvents = buildLinkedInRawEventsFromRealtimeEnvelope({
      accountKey: "default",
      userEntityUrn: "urn:li:member:SELF123",
      envelope: {
        "com.linkedin.realtimefrontend.DecoratedEvent": {
          topic: "urn:li-realtime:messageSeenReceiptsTopic:123",
          leftServerAt: 1_700_000_000_000,
          id: "evt-1",
          payload: {
            data: {
              doDecorateSeenReceiptMessengerRealtimeDecoration: {
                result: {
                  seenAt: 1_700_000_000_123,
                  seenByParticipant: peerParticipant,
                  message: {
                    entityURN: "urn:li:fsd_message:MSG1",
                    body: { text: "hello" },
                    deliveredAt: 1_700_000_000_100,
                    sender: selfParticipant,
                    messageBodyRenderFormat: "DEFAULT",
                    renderContent: [],
                    reactionSummaries: [],
                    conversationURN: "urn:li:fsd_conversation:CONV1",
                    conversation: {
                      title: "Ava Chen",
                      entityURN: "urn:li:fsd_conversation:CONV1",
                      lastActivityAt: 1_700_000_000_100,
                      lastReadAt: 1_700_000_000_123,
                      groupChat: false,
                      read: true,
                      categories: ["PRIMARY_INBOX"],
                      unreadCount: 0,
                      conversationParticipants: [selfParticipant, peerParticipant],
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const messageEvent = rawEvents.find((event) => event.entityKind === "message");
    expect(messageEvent?.eventKind).toBe("read_receipt");
    expect(messageEvent?.payload).toEqual(
      expect.objectContaining({
        readAt: 1_700_000_000_123,
        status: "read",
      }),
    );
  });

  it("maps group seen receipts onto timeline events", () => {
    const rawEvents = buildLinkedInRawEventsFromRealtimeEnvelope({
      accountKey: "default",
      userEntityUrn: "urn:li:member:SELF123",
      envelope: {
        "com.linkedin.realtimefrontend.DecoratedEvent": {
          topic: "urn:li-realtime:messageSeenReceiptsTopic:123",
          leftServerAt: 1_700_000_100_000,
          id: "evt-2",
          payload: {
            data: {
              doDecorateSeenReceiptMessengerRealtimeDecoration: {
                result: {
                  seenAt: 1_700_000_100_123,
                  seenByParticipant: peerParticipant,
                  message: {
                    entityURN: "urn:li:fsd_message:MSG2",
                    body: { text: "hello group" },
                    deliveredAt: 1_700_000_100_100,
                    sender: selfParticipant,
                    messageBodyRenderFormat: "DEFAULT",
                    renderContent: [],
                    reactionSummaries: [],
                    conversationURN: "urn:li:fsd_conversation:CONV2",
                    conversation: {
                      title: "Team chat",
                      entityURN: "urn:li:fsd_conversation:CONV2",
                      lastActivityAt: 1_700_000_100_100,
                      lastReadAt: 1_700_000_100_123,
                      groupChat: true,
                      read: true,
                      categories: ["PRIMARY_INBOX"],
                      unreadCount: 0,
                      conversationParticipants: [selfParticipant, peerParticipant],
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(rawEvents.some((event) => event.entityKind === "timeline_event")).toBe(true);
    expect(rawEvents.some((event) => event.eventKind === "system_message")).toBe(true);
    expect(rawEvents.some((event) => event.entityKind === "message")).toBe(false);
  });

  it("keeps archived realtime threads removed instead of reactivating them", () => {
    const rawEvents = buildLinkedInRawEventsFromRealtimeEnvelope({
      accountKey: "default",
      userEntityUrn: "urn:li:member:SELF123",
      envelope: {
        "com.linkedin.realtimefrontend.DecoratedEvent": {
          topic: "urn:li-realtime:messagesTopic:123",
          leftServerAt: 1_700_000_200_000,
          id: "evt-3",
          payload: {
            data: {
              doDecorateMessageMessengerRealtimeDecoration: {
                result: {
                  entityURN: "urn:li:fsd_message:MSG3",
                  body: { text: "archive me" },
                  deliveredAt: 1_700_000_200_100,
                  sender: peerParticipant,
                  messageBodyRenderFormat: "DEFAULT",
                  renderContent: [],
                  reactionSummaries: [],
                  conversationURN: "urn:li:fsd_conversation:CONV3",
                  conversation: {
                    title: "Archived chat",
                    entityURN: "urn:li:fsd_conversation:CONV3",
                    lastActivityAt: 1_700_000_200_100,
                    lastReadAt: 1_700_000_200_100,
                    groupChat: false,
                    read: true,
                    categories: ["ARCHIVED"],
                    unreadCount: 0,
                    conversationParticipants: [selfParticipant, peerParticipant],
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(
      rawEvents.some(
        (event) => event.entityKind === "conversation" && event.eventKind === "removed",
      ),
    ).toBe(true);
    expect(
      rawEvents.find(
        (event) => event.entityKind === "conversation" && event.eventKind === "removed",
      )?.payload,
    ).toEqual(
      expect.objectContaining({
        removalReason: "archived",
        participants: expect.arrayContaining([
          expect.objectContaining({
            sourceEntityKey: "linkedin:urn:li:member:SELF123",
            isSelf: true,
          }),
        ]),
      }),
    );
    expect(rawEvents.some((event) => event.entityKind === "message")).toBe(false);
    expect(rawEvents.some((event) => event.entityKind === "timeline_event")).toBe(false);
  });

  it("maps system realtime messages onto canonical timeline events", () => {
    const rawEvents = buildLinkedInRawEventsFromRealtimeEnvelope({
      accountKey: "default",
      userEntityUrn: "urn:li:member:SELF123",
      envelope: {
        "com.linkedin.realtimefrontend.DecoratedEvent": {
          topic: "urn:li-realtime:messagesTopic:123",
          leftServerAt: 1_700_000_300_000,
          id: "evt-4",
          payload: {
            data: {
              doDecorateMessageMessengerRealtimeDecoration: {
                result: {
                  entityURN: "urn:li:fsd_message:MSG4",
                  body: { text: "Ava renamed the conversation" },
                  deliveredAt: 1_700_000_300_100,
                  sender: peerParticipant,
                  messageBodyRenderFormat: "SYSTEM",
                  renderContent: [],
                  reactionSummaries: [],
                  conversationURN: "urn:li:fsd_conversation:CONV4",
                  conversation: {
                    title: "Renamed chat",
                    entityURN: "urn:li:fsd_conversation:CONV4",
                    lastActivityAt: 1_700_000_300_100,
                    lastReadAt: 1_700_000_300_100,
                    groupChat: false,
                    read: true,
                    categories: ["PRIMARY_INBOX"],
                    unreadCount: 0,
                    conversationParticipants: [selfParticipant, peerParticipant],
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(
      rawEvents.some(
        (event) => event.entityKind === "timeline_event" && event.eventKind === "system_message",
      ),
    ).toBe(true);
    expect(rawEvents.some((event) => event.entityKind === "message")).toBe(false);
  });
});
