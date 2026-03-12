import { describe, expect, it } from "vitest";
import { buildLinkedInSyncBundle } from "../workers/linkedin-worker-lib.js";

describe("buildLinkedInSyncBundle", () => {
  it("builds raw events from conversations, messages, and connections", async () => {
    const bundle = await buildLinkedInSyncBundle({
      accountKey: "default",
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
});
