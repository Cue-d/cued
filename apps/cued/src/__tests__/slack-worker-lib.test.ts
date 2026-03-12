import { describe, expect, it } from "vitest";
import { buildSlackSyncBundle } from "../workers/slack-worker-lib.js";

describe("slack worker lib", () => {
  it("builds a raw event bundle from Slack users, conversations, messages, and reactions", async () => {
    const bundle = await buildSlackSyncBundle({
      accountKey: "default",
      client: {
        async testAuth() {
          return { ok: true, team_id: "T123", user_id: "U_SELF", team: "Acme", user: "Ava" };
        },
        async listUsers() {
          return {
            users: [
              {
                id: "U_SELF",
                team_id: "T123",
                name: "ava",
                real_name: "Ava Chen",
                profile: { email: "ava@example.com", image_192: "https://img/ava.png" },
              },
              {
                id: "U_BEN",
                team_id: "T123",
                name: "ben",
                real_name: "Ben Ortiz",
                profile: { email: "ben@example.com" },
              },
            ],
            nextCursor: undefined,
          };
        },
        async listConversations() {
          return {
            conversations: [
              {
                id: "D123",
                is_im: true,
                user: "U_BEN",
                latest: undefined,
              },
            ],
            nextCursor: undefined,
          };
        },
        async getConversationMembers() {
          return { members: [], nextCursor: undefined };
        },
        async getHistory() {
          return {
            messages: [
              {
                type: "message",
                user: "U_BEN",
                text: "Hi from Slack",
                ts: "1710000000.000100",
                reply_count: 1,
                reactions: [{ name: "thumbsup", count: 1, users: ["U_SELF"] }],
                files: [
                  {
                    id: "F1",
                    name: "resume.pdf",
                    url_private_download: "https://files/resume.pdf",
                  },
                ],
              },
            ],
            hasMore: false,
            nextCursor: undefined,
          };
        },
        async getReplies() {
          return {
            messages: [
              {
                type: "message",
                user: "U_BEN",
                text: "Thread reply",
                ts: "1710000000.000200",
                thread_ts: "1710000000.000100",
              },
            ],
            hasMore: false,
            nextCursor: undefined,
          };
        },
      },
    });

    expect(bundle.sourceAccounts).toEqual([
      { platform: "slack", accountKey: "default", displayName: "Acme" },
    ]);
    expect(bundle.syncMode).toBe("full");
    expect(bundle.sourceCursor).toEqual(
      expect.objectContaining({ teamId: "T123", selfUserId: "U_SELF" }),
    );
    expect(bundle.rawEvents.some((event) => event.entityKind === "contact")).toBe(true);
    expect(bundle.rawEvents.some((event) => event.entityKind === "conversation")).toBe(true);
    expect(bundle.rawEvents.some((event) => event.entityKind === "message")).toBe(true);
    expect(bundle.rawEvents.some((event) => event.entityKind === "reaction")).toBe(true);

    const messageEvent = bundle.rawEvents.find((event) => event.entityKind === "message");
    expect(messageEvent?.payload).toEqual(
      expect.objectContaining({
        sourceConversationKey: "slack:T123:D123",
        senderSourceKey: "slack:T123:U_BEN",
        content: "Hi from Slack",
        isFromMe: false,
        service: "slack",
        attachments: expect.any(Array),
      }),
    );
    expect(
      bundle.rawEvents.some(
        (event) =>
          event.entityKind === "message" &&
          (event.payload as Record<string, unknown>).replyToSourceMessageKey ===
            "slack:T123:D123:1710000000.000100",
      ),
    ).toBe(true);
  });

  it("treats empty conversation cursors as end-of-pagination", async () => {
    const bundle = await buildSlackSyncBundle({
      accountKey: "default",
      client: {
        async testAuth() {
          return { ok: true, team_id: "T123", user_id: "U_SELF", team: "Acme", user: "Ava" };
        },
        async listUsers() {
          return {
            users: [
              {
                id: "U_SELF",
                team_id: "T123",
                name: "ava",
                real_name: "Ava Chen",
                profile: {},
              },
            ],
            nextCursor: undefined,
          };
        },
        async listConversations() {
          return {
            conversations: [],
            nextCursor: "",
          };
        },
        async getConversationMembers() {
          return { members: [], nextCursor: undefined };
        },
        async getHistory() {
          return { messages: [], hasMore: false, nextCursor: undefined };
        },
        async getReplies() {
          return { messages: [], hasMore: false, nextCursor: undefined };
        },
      },
    });

    expect(bundle.hasMore).toBe(false);
    expect(bundle.sourceCursor).toEqual(
      expect.objectContaining({
        teamId: "T123",
        selfUserId: "U_SELF",
      }),
    );
    expect((bundle.sourceCursor as Record<string, unknown>).scan).toBeUndefined();
  });
});
