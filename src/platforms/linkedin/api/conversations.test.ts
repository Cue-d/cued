import { afterEach, describe, expect, it, vi } from "vitest";
import { getConversations } from "./conversations.js";

const cookies = [
  {
    name: "li_at",
    value: "token",
    domain: ".linkedin.com",
    path: "/",
  },
  {
    name: "JSESSIONID",
    value: '"ajax:123"',
    domain: ".linkedin.com",
    path: "/",
  },
];

describe("linkedin conversations bootstrap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the current bootstrap query id and parses sync-token shaped responses", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      expect(url).toContain("queryId=messengerConversations.0d5e6781bbee71c3e51c8843c6519f48");
      expect(url).toContain("variables=(mailboxUrn:urn%3Ali%3Afsd_profile%3ASELF123)");

      return new Response(
        JSON.stringify({
          data: {
            messengerConversationsBySyncToken: {
              elements: [
                {
                  entityUrn: "urn:li:msg_conversation:(urn:li:fsd_profile:SELF123,CONV123)",
                  lastActivityAt: 1700000000000,
                  lastReadAt: 1700000000000,
                  read: true,
                  groupChat: false,
                  categories: ["INBOX", "PRIMARY_INBOX"],
                  conversationParticipants: [
                    {
                      entityUrn: "urn:li:member:OTHER123",
                      participantType: {
                        member: {
                          profileUrl: "https://www.linkedin.com/in/other",
                          firstName: { text: "Other" },
                          lastName: { text: "Person" },
                        },
                      },
                    },
                  ],
                },
              ],
              metadata: {
                newSyncToken: "sync-token-1",
                nextCursor: "cursor-2",
              },
            },
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = {
      cookies,
      pageInstance: "urn:li:page:messaging_thread;",
      xLiTrack: "{}",
      getMailboxUrn: vi.fn(async () => "urn%3Ali%3Afsd_profile%3ASELF123"),
    };

    const result = await getConversations(client as never);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.syncToken).toBe("sync-token-1");
    expect(result.nextCursor).toBe("cursor-2");
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0]?.entityURN).toBe(
      "urn:li:msg_conversation:(urn:li:fsd_profile:SELF123,CONV123)",
    );
  });
});
