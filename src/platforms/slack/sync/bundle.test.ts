import { describe, expect, it, vi } from "vitest";
import { buildSlackSyncBundle } from "./bundle.js";

describe("slack worker lib", () => {
  it("builds a raw event bundle from Slack users, conversations, messages, and reactions", async () => {
    const historyOldestValues: string[] = [];
    const repliesOldestValues: string[] = [];
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
        async getHistory(_conversationId, options) {
          historyOldestValues.push(String(options?.oldest ?? ""));
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
        async getReplies(_conversationId, _threadTs, options) {
          repliesOldestValues.push(String(options?.oldest ?? ""));
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
    expect(historyOldestValues).toEqual([""]);
    expect(repliesOldestValues).toEqual([""]);
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

  it("treats empty conversation pages with a dangling cursor as end-of-pagination", async () => {
    const bundle = await buildSlackSyncBundle({
      accountKey: "default",
      sourceCursor: {
        teamId: "T123",
        selfUserId: "U_SELF",
        lastSyncAt: 1710000000000,
        scan: {
          mode: "full",
          startedAt: 1710000000000,
          oldestMs: 0,
          usersComplete: true,
          conversationCursor: "dead-cursor",
        },
      },
      client: {
        async testAuth() {
          return { ok: true, team_id: "T123", user_id: "U_SELF", team: "Acme", user: "Ava" };
        },
        async listUsers() {
          return { users: [], nextCursor: undefined };
        },
        async listConversations() {
          return {
            conversations: [],
            nextCursor: "still-more",
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
    expect(bundle.sourceCursor).toEqual({
      teamId: "T123",
      selfUserId: "U_SELF",
      lastSyncAt: 1710000000000,
    });
  });

  it("keeps incremental Slack syncs bounded to the last sync window", async () => {
    const historyOldestValues: string[] = [];
    const lastSyncAt = 1710000000000;
    const expectedOldest = ((lastSyncAt - 5 * 60 * 1000) / 1000).toFixed(6);

    await buildSlackSyncBundle({
      accountKey: "default",
      lastSyncAt,
      client: {
        async testAuth() {
          return { ok: true, team_id: "T123", user_id: "U_SELF", team: "Acme", user: "Ava" };
        },
        async listUsers() {
          return { users: [], nextCursor: undefined };
        },
        async listConversations() {
          return {
            conversations: [
              {
                id: "C123",
                is_channel: true,
              },
            ],
            nextCursor: undefined,
          };
        },
        async getConversationMembers() {
          return { members: [], nextCursor: undefined };
        },
        async getHistory(_conversationId, options) {
          historyOldestValues.push(String(options?.oldest ?? ""));
          return { messages: [], hasMore: false, nextCursor: undefined };
        },
        async getReplies() {
          return { messages: [], hasMore: false, nextCursor: undefined };
        },
      },
    });

    expect(historyOldestValues).toEqual([expectedOldest]);
  });

  it("does not keep paginating incremental scans when slack returns a next cursor", async () => {
    const bundle = await buildSlackSyncBundle({
      accountKey: "default",
      lastSyncAt: 1710000000000,
      client: {
        async testAuth() {
          return { ok: true, team_id: "T123", user_id: "U_SELF", team: "Acme", user: "Ava" };
        },
        async listUsers() {
          return { users: [], nextCursor: undefined };
        },
        async listConversations() {
          return {
            conversations: [
              {
                id: "C123",
                is_channel: true,
                latest: {
                  type: "message",
                  text: "Recent channel update",
                  ts: "1710000300.000000",
                },
              },
            ],
            nextCursor: "page-2",
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

    expect(bundle.syncMode).toBe("incremental");
    expect(bundle.hasMore).toBe(false);
    expect((bundle.sourceCursor as Record<string, unknown>).scan).toBeUndefined();
  });

  it("bounds full public channel history to a recent window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T17:00:00.000Z"));
    const historyOldestValues: string[] = [];
    const expectedOldest = String(Date.parse("2026-02-14T17:00:00.000Z") / 1000);

    try {
      await buildSlackSyncBundle({
        accountKey: "default",
        client: {
          async testAuth() {
            return { ok: true, team_id: "T123", user_id: "U_SELF", team: "Acme", user: "Ava" };
          },
          async listUsers() {
            return { users: [], nextCursor: undefined };
          },
          async listConversations() {
            return {
              conversations: [
                {
                  id: "C123",
                  is_channel: true,
                  num_members: 4200,
                },
              ],
              nextCursor: undefined,
            };
          },
          async getConversationMembers() {
            return { members: [], nextCursor: undefined };
          },
          async getHistory(_conversationId, options) {
            historyOldestValues.push(String(options?.oldest ?? ""));
            return { messages: [], hasMore: false, nextCursor: undefined };
          },
          async getReplies() {
            return { messages: [], hasMore: false, nextCursor: undefined };
          },
        },
      });
    } finally {
      vi.useRealTimers();
    }

    expect(historyOldestValues).toEqual([`${expectedOldest}.000000`]);
  });
});
