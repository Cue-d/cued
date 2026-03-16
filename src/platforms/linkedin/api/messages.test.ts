import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "./messages.js";

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

describe("linkedin messages", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the current message query id and parses sync-token shaped responses", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      expect(url).toContain("queryId=messengerMessages.5846eeb71c981f11e0134cb6626cc314");
      expect(url).toContain(
        "variables=(conversationUrn:urn%3Ali%3Amsg_conversation%3A%28urn%3Ali%3Afsd_profile%3ASELF123%2CCONV123%29)",
      );
      expect(url).not.toContain("count:");

      return new Response(
        JSON.stringify({
          data: {
            messengerMessagesBySyncToken: {
              metadata: {
                newSyncToken: "message-sync-token-1",
              },
              elements: [
                {
                  entityUrn: "urn:li:fsd_message:MSG123",
                  deliveredAt: 1_700_000_000_000,
                  body: {
                    text: "Latest LinkedIn message",
                    attributes: [],
                  },
                  sender: {
                    entityUrn: "urn:li:fsd_profile:OTHER123",
                    participantType: {
                      member: {
                        firstName: "Other",
                        lastName: "Person",
                        profileUrl: "https://www.linkedin.com/in/other",
                      },
                    },
                  },
                  conversationUrn: "urn:li:msg_conversation:(urn:li:fsd_profile:SELF123,CONV123)",
                  reactionSummaries: [],
                },
              ],
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

    const result = await getMessages(
      {
        cookies,
        pageInstance: "urn:li:page:messaging_thread;",
        xLiTrack: "{}",
      } as never,
      "urn:li:msg_conversation:(urn:li:fsd_profile:SELF123,CONV123)",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.prevCursor).toBeNull();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual(
      expect.objectContaining({
        entityURN: "urn:li:fsd_message:MSG123",
        conversationURN: "urn:li:msg_conversation:(urn:li:fsd_profile:SELF123,CONV123)",
        body: expect.objectContaining({
          text: "Latest LinkedIn message",
        }),
      }),
    );
  });
});
