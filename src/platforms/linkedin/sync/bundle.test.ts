import { describe, expect, it, vi } from "vitest";
import { LinkedInRequestError } from "../api/request.js";
import { buildLinkedInSyncBundle } from "./bundle.js";

describe("buildLinkedInSyncBundle", () => {
  it("builds raw events from conversations, messages, and connections", async () => {
    const bundle = await buildLinkedInSyncBundle({
      accountKey: "default",
      loadProjectedReactions: () => new Map(),
      client: {
        async fetchSelf() {
          return "urn:li:fsd_profile:SELF123";
        },
        async getConnections() {
          return {
            connections: [
              {
                profileId: "ACoAAA1",
                profileUrl: "https://www.linkedin.com/in/ava-chen",
                firstName: "Ava",
                lastName: "Chen",
                headline: "Founder at Cued",
                picture: { url: "https://cdn.example.com/ava.jpg" },
              },
            ],
            metadata: { count: 1, total: 1 },
          };
        },
        async getConversations() {
          return {
            conversations: [
              {
                title: "Ava Chen",
                entityURN: "urn:li:fsd_conversation:CONV123",
                lastActivityAt: 1_700_000_000_000,
                lastReadAt: 1_700_000_000_000,
                groupChat: false,
                read: true,
                categories: ["PRIMARY_INBOX"],
                unreadCount: 0,
                conversationParticipants: [
                  {
                    entityURN: "urn:li:fsd_profile:SELF123",
                    participantType: {
                      member: {
                        firstName: "Theo",
                        lastName: "Tarr",
                        profileUrl: "https://www.linkedin.com/in/theotarr",
                      },
                    },
                  },
                  {
                    entityURN: "urn:li:fsd_profile:ACoAAA1",
                    participantType: {
                      member: {
                        firstName: "Ava",
                        lastName: "Chen",
                        headline: "Founder at Cued",
                        profileUrl: "https://www.linkedin.com/in/ava-chen",
                        picture: { url: "https://cdn.example.com/ava.jpg" },
                      },
                    },
                  },
                ],
                messages: {
                  elements: [
                    {
                      entityURN: "urn:li:fsd_message:MSG123",
                      body: { text: "Let’s catch up next week." },
                      deliveredAt: 1_700_000_000_000,
                      sender: {
                        entityURN: "urn:li:fsd_profile:ACoAAA1",
                        participantType: {
                          member: {
                            firstName: "Ava",
                            lastName: "Chen",
                            profileUrl: "https://www.linkedin.com/in/ava-chen",
                          },
                        },
                      },
                      messageBodyRenderFormat: "DEFAULT" as const,
                      renderContent: [],
                      reactionSummaries: [],
                      conversationURN: "urn:li:fsd_conversation:CONV123",
                    },
                  ],
                },
              },
            ],
            metadata: { count: 1, total: 1 },
            syncToken: "sync-token-1",
          };
        },
        async getConversationsBefore() {
          return {
            conversations: [],
            metadata: { count: 0, total: 0 },
          };
        },
        async getMessages() {
          return { messages: [], metadata: { count: 0, total: 0 } };
        },
        async getMessagesBefore() {
          return { messages: [], metadata: { count: 0, total: 0 } };
        },
        async getMessagesWithPrevCursor() {
          return { messages: [], metadata: { count: 0, total: 0 }, prevCursor: null };
        },
        async getReactors() {
          return [];
        },
      },
    });

    expect(bundle.sourceAccounts).toEqual([
      { platform: "linkedin", accountKey: "default", displayName: "LinkedIn" },
    ]);
    expect(bundle.sourceCursor).toEqual(
      expect.objectContaining({
        syncToken: "sync-token-1",
        userEntityUrn: "urn:li:member:SELF123",
      }),
    );
    expect(bundle.rawEvents.some((event) => event.entityKind === "contact")).toBe(true);
    expect(bundle.rawEvents.some((event) => event.entityKind === "conversation")).toBe(true);
    expect(bundle.rawEvents.some((event) => event.entityKind === "message")).toBe(true);

    const messageEvent = bundle.rawEvents.find((event) => event.entityKind === "message");
    expect(messageEvent?.payload).toEqual(
      expect.objectContaining({
        sourceConversationKey: "linkedin:urn:li:fs_conversation:CONV123",
        sourceMessageKey: "linkedin:urn:li:fsd_message:MSG123",
        senderSourceKey: "linkedin:urn:li:member:ACoAAA1",
        content: "Let’s catch up next week.",
        service: "linkedin",
        isFromMe: false,
      }),
    );
  });

  it("emits removal, system, reply, attachment, and reaction events", async () => {
    const bundle = await buildLinkedInSyncBundle({
      accountKey: "default",
      loadProjectedReactions: () => new Map(),
      client: {
        async fetchSelf() {
          return "urn:li:fsd_profile:SELF123";
        },
        async getConnections() {
          return { connections: [] };
        },
        async getConversations() {
          return {
            conversations: [
              {
                title: "Ava Chen",
                entityURN: "urn:li:fsd_conversation:CONV_ACTIVE",
                lastActivityAt: 1_700_000_100_000,
                lastReadAt: 1_700_000_100_000,
                groupChat: false,
                read: true,
                categories: ["PRIMARY_INBOX"],
                unreadCount: 0,
                conversationParticipants: [
                  {
                    entityURN: "urn:li:fsd_profile:SELF123",
                    participantType: {
                      member: { firstName: "Theo", lastName: "Tarr", profileUrl: "" },
                    },
                  },
                  {
                    entityURN: "urn:li:fsd_profile:ACoAAA1",
                    participantType: {
                      member: {
                        firstName: "Ava",
                        lastName: "Chen",
                        profileUrl: "https://www.linkedin.com/in/ava-chen",
                      },
                    },
                  },
                ],
              },
              {
                title: "Spam Chat",
                entityURN: "urn:li:fsd_conversation:CONV_SPAM",
                lastActivityAt: 1_700_000_200_000,
                lastReadAt: 1_700_000_200_000,
                groupChat: false,
                read: true,
                categories: ["SPAM"],
                unreadCount: 0,
                conversationParticipants: [],
              },
            ],
            deletedConversationURNs: ["urn:li:fsd_conversation:CONV_DELETED"],
            syncToken: "sync-token-2",
          };
        },
        async getConversationsBefore() {
          return { conversations: [] };
        },
        async getMessages() {
          return {
            messages: [
              {
                entityURN: "urn:li:fsd_message:MSG_REPLY",
                body: { text: "Here is the spec" },
                deliveredAt: 1_700_000_100_000,
                sender: {
                  entityURN: "urn:li:fsd_profile:ACoAAA1",
                  participantType: {
                    member: {
                      firstName: "Ava",
                      lastName: "Chen",
                      profileUrl: "https://www.linkedin.com/in/ava-chen",
                    },
                  },
                },
                messageBodyRenderFormat: "EDITED" as const,
                renderContent: [
                  {
                    repliedMessageContent: {
                      originalMessage: {
                        entityUrn: "urn:li:fsd_message:MSG_PARENT",
                      },
                    },
                  },
                  {
                    file: {
                      assetUrn: "asset-1",
                      name: "spec.pdf",
                      mediaType: "application/pdf",
                      byteSize: 1234,
                      url: "https://cdn.example.com/spec.pdf",
                    },
                  },
                ],
                reactionSummaries: [
                  {
                    emoji: "👍",
                    count: 1,
                    viewerReacted: false,
                    firstReactedAt: 1_700_000_100_100,
                  },
                ],
                conversationURN: "urn:li:fsd_conversation:CONV_ACTIVE",
              },
              {
                entityURN: "urn:li:fsd_message:MSG_SYSTEM",
                body: { text: "Ava renamed the conversation" },
                deliveredAt: 1_700_000_100_200,
                sender: {
                  entityURN: "urn:li:fsd_profile:ACoAAA1",
                  participantType: {
                    member: {
                      firstName: "Ava",
                      lastName: "Chen",
                      profileUrl: "https://www.linkedin.com/in/ava-chen",
                    },
                  },
                },
                messageBodyRenderFormat: "SYSTEM" as const,
                renderContent: [],
                reactionSummaries: [],
                conversationURN: "urn:li:fsd_conversation:CONV_ACTIVE",
              },
            ],
            prevCursor: null,
          };
        },
        async getMessagesBefore() {
          return { messages: [], prevCursor: null };
        },
        async getMessagesWithPrevCursor() {
          return { messages: [], prevCursor: null };
        },
        async getReactors() {
          return [
            {
              entityURN: "urn:li:fsd_profile:ACoAAA1",
              participantType: {
                member: {
                  firstName: "Ava",
                  lastName: "Chen",
                  profileUrl: "https://www.linkedin.com/in/ava-chen",
                },
              },
            },
          ];
        },
      },
    });

    expect(
      bundle.rawEvents.some(
        (event) => event.entityKind === "conversation" && event.eventKind === "removed",
      ),
    ).toBe(true);
    expect(
      bundle.rawEvents.find(
        (event) => event.entityKind === "conversation" && event.eventKind === "removed",
      )?.payload,
    ).toEqual(
      expect.objectContaining({
        removalReason: "deleted",
      }),
    );
    expect(
      bundle.rawEvents.some(
        (event) => event.entityKind === "timeline_event" && event.eventKind === "system_message",
      ),
    ).toBe(true);

    const messageEvent = bundle.rawEvents.find(
      (event) =>
        event.entityKind === "message" && event.externalEntityId === "urn:li:fsd_message:MSG_REPLY",
    );
    expect(messageEvent?.payload).toEqual(
      expect.objectContaining({
        replyToSourceMessageKey: "linkedin:urn:li:fsd_message:MSG_PARENT",
        isEdited: true,
        attachments: [
          expect.objectContaining({
            kind: "file",
            filename: "spec.pdf",
            mime_type: "application/pdf",
            remote_url: "https://cdn.example.com/spec.pdf",
          }),
        ],
      }),
    );

    expect(
      bundle.rawEvents.find(
        (event) => event.entityKind === "timeline_event" && event.eventKind === "system_message",
      ),
    ).toBeTruthy();
    expect(
      bundle.rawEvents.find(
        (event) =>
          event.entityKind === "message" &&
          event.externalEntityId === "urn:li:fsd_message:MSG_SYSTEM",
      ),
    ).toBeFalsy();

    expect(
      bundle.rawEvents.find(
        (event) =>
          event.entityKind === "reaction" &&
          event.payload &&
          (event.payload as { emoji?: string }).emoji === "👍",
      ),
    ).toBeTruthy();
  });

  it("does not anchor-paginate empty conversations", async () => {
    const getMessagesBefore = vi.fn(async () => {
      throw new Error("should not paginate empty conversations");
    });

    await buildLinkedInSyncBundle({
      accountKey: "default",
      loadProjectedReactions: () => new Map(),
      client: {
        async fetchSelf() {
          return "urn:li:fsd_profile:SELF123";
        },
        async getConnections() {
          return { connections: [] };
        },
        async getConversations() {
          return {
            conversations: [
              {
                title: "Fresh thread",
                entityURN: "urn:li:fsd_conversation:CONV_EMPTY",
                lastActivityAt: 1_700_000_300_000,
                lastReadAt: 1_700_000_300_000,
                groupChat: false,
                read: true,
                categories: ["PRIMARY_INBOX"],
                unreadCount: 0,
                conversationParticipants: [
                  {
                    entityURN: "urn:li:fsd_profile:SELF123",
                    participantType: {
                      member: {
                        firstName: "Theo",
                        lastName: "Tarr",
                        profileUrl: "https://www.linkedin.com/in/theotarr",
                      },
                    },
                  },
                  {
                    entityURN: "urn:li:fsd_profile:ACoAAA2",
                    participantType: {
                      member: {
                        firstName: "Mina",
                        lastName: "Park",
                        profileUrl: "https://www.linkedin.com/in/mina-park",
                      },
                    },
                  },
                ],
              },
            ],
            syncToken: "sync-token-empty",
          };
        },
        async getConversationsBefore() {
          return { conversations: [] };
        },
        async getMessages() {
          return { messages: [], prevCursor: null };
        },
        getMessagesBefore,
        async getMessagesWithPrevCursor() {
          return { messages: [], prevCursor: null };
        },
        async getReactors() {
          return [];
        },
      },
    });

    expect(getMessagesBefore).not.toHaveBeenCalled();
  });

  it("keeps syncing when older linkedin message pagination returns 400", async () => {
    const bundle = await buildLinkedInSyncBundle({
      accountKey: "default",
      loadProjectedReactions: () => new Map(),
      client: {
        async fetchSelf() {
          return "urn:li:fsd_profile:SELF123";
        },
        async getConnections() {
          return { connections: [] };
        },
        async getConversations() {
          return {
            conversations: [
              {
                title: "Ava Chen",
                entityURN: "urn:li:msg_conversation:(urn:li:fsd_profile:SELF123,CONV123)",
                lastActivityAt: 1_700_000_100_000,
                lastReadAt: 1_700_000_100_000,
                groupChat: false,
                read: true,
                categories: ["INBOX", "PRIMARY_INBOX"],
                unreadCount: 0,
                conversationParticipants: [
                  {
                    entityURN: "urn:li:msg_messagingParticipant:urn:li:fsd_profile:SELF123",
                    participantType: {
                      member: { firstName: "Theo", lastName: "Tarr", profileUrl: "" },
                    },
                  },
                  {
                    entityURN: "urn:li:msg_messagingParticipant:urn:li:fsd_profile:OTHER456",
                    participantType: {
                      member: {
                        firstName: "Ava",
                        lastName: "Chen",
                        profileUrl: "https://www.linkedin.com/in/ava-chen",
                      },
                    },
                  },
                ],
                messages: {
                  elements: [
                    {
                      entityURN: "urn:li:fsd_message:MSG_EMBEDDED",
                      body: { text: "Embedded latest" },
                      deliveredAt: 1_700_000_090_000,
                      sender: {
                        entityURN: "urn:li:msg_messagingParticipant:urn:li:fsd_profile:OTHER456",
                        participantType: {},
                      },
                      messageBodyRenderFormat: "DEFAULT" as const,
                      renderContent: [],
                      reactionSummaries: [],
                      conversationURN: "",
                    },
                  ],
                },
              },
            ],
            deletedConversationURNs: [],
            syncToken: "sync-token-live",
          };
        },
        async getConversationsBefore() {
          return { conversations: [] };
        },
        async getMessages() {
          return {
            messages: [
              {
                entityURN: "urn:li:fsd_message:MSG_LIVE",
                body: { text: "Live latest" },
                deliveredAt: 1_700_000_100_000,
                sender: {
                  entityURN: "urn:li:msg_messagingParticipant:urn:li:fsd_profile:OTHER456",
                  participantType: {},
                },
                messageBodyRenderFormat: "DEFAULT" as const,
                renderContent: [],
                reactionSummaries: [],
                conversationURN: "urn:li:msg_conversation:(urn:li:fsd_profile:SELF123,CONV123)",
              },
            ],
            prevCursor: null,
          };
        },
        async getMessagesBefore() {
          throw new LinkedInRequestError("Request failed: 400 Bad Request", 400, '{"status":400}');
        },
        async getMessagesWithPrevCursor() {
          throw new LinkedInRequestError("Request failed: 400 Bad Request", 400, '{"status":400}');
        },
        async getReactors() {
          return [];
        },
      },
    });

    expect(bundle.rawEvents.some((event) => event.entityKind === "conversation")).toBe(true);
    expect(
      bundle.rawEvents.some(
        (event) =>
          event.entityKind === "message" &&
          event.externalEntityId === "urn:li:fsd_message:MSG_LIVE",
      ),
    ).toBe(true);
  });

  it("accepts msg-style urns from the live linkedin messaging API", async () => {
    const bundle = await buildLinkedInSyncBundle({
      accountKey: "default",
      loadProjectedReactions: () => new Map(),
      client: {
        async fetchSelf() {
          return "urn:li:fsd_profile:SELF123";
        },
        async getConnections() {
          return { connections: [] };
        },
        async getConversations() {
          return {
            conversations: [
              {
                title: "",
                entityURN: "urn:li:msg_conversation:(urn:li:fsd_profile:SELF123,CONV123)",
                lastActivityAt: 1_700_000_000_000,
                lastReadAt: 1_700_000_000_000,
                groupChat: false,
                read: true,
                categories: ["INBOX", "PRIMARY_INBOX"],
                unreadCount: 0,
                conversationParticipants: [
                  {
                    entityURN: "urn:li:msg_messagingParticipant:urn:li:fsd_profile:SELF123",
                    participantType: {
                      member: { firstName: "Theo", lastName: "Tarr", profileUrl: "" },
                    },
                  },
                  {
                    entityURN: "urn:li:msg_messagingParticipant:urn:li:fsd_profile:OTHER456",
                    participantType: {
                      member: {
                        firstName: "Ava",
                        lastName: "Chen",
                        profileUrl: "https://www.linkedin.com/in/ava-chen",
                      },
                    },
                  },
                ],
                messages: {
                  elements: [
                    {
                      entityURN: "urn:li:msg_message:(SELF123,MSG123)",
                      body: { text: "Live API message" },
                      deliveredAt: 1_700_000_000_000,
                      sender: {
                        entityURN: "urn:li:msg_messagingParticipant:urn:li:fsd_profile:OTHER456",
                        participantType: {},
                      },
                      messageBodyRenderFormat: "DEFAULT" as const,
                      renderContent: [],
                      reactionSummaries: [],
                      conversationURN: "",
                    },
                  ],
                },
              },
            ],
            deletedConversationURNs: [],
            syncToken: "sync-token-live",
          };
        },
        async getConversationsBefore() {
          return { conversations: [] };
        },
        async getMessages() {
          return { messages: [], prevCursor: null };
        },
        async getMessagesBefore() {
          return { messages: [], prevCursor: null };
        },
        async getMessagesWithPrevCursor() {
          return { messages: [], prevCursor: null };
        },
        async getReactors() {
          return [];
        },
      },
    });

    expect(bundle.rawEvents.some((event) => event.entityKind === "conversation")).toBe(true);
    expect(bundle.rawEvents.some((event) => event.entityKind === "message")).toBe(true);
    expect(
      bundle.rawEvents.some(
        (event) => event.entityKind === "conversation" && event.eventKind === "removed",
      ),
    ).toBe(false);
  });
});
