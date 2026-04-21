import { describe, expect, it } from "vitest";
import { buildSlackSyncBundle } from "./bundle.js";

describe("slack worker lib", () => {
  it("builds a raw event bundle from Slack users, conversations, messages, and reactions", async () => {
    const historyOldestValues: string[] = [];
    const repliesOldestValues: string[] = [];
    const historyLimits: number[] = [];
    const repliesLimits: number[] = [];
    const listedTypes: string[] = [];
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
        async listConversations(types) {
          listedTypes.push(types);
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
          historyLimits.push(Number(options?.limit ?? 0));
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
          repliesLimits.push(Number(options?.limit ?? 0));
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
    expect(listedTypes).toEqual(["im,mpim"]);
    expect(historyOldestValues).toEqual([""]);
    expect(repliesOldestValues).toEqual([""]);
    expect(historyLimits).toEqual([100]);
    expect(repliesLimits).toEqual([50]);
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

    expect(bundle.hasMore).toBe(true);
    expect(bundle.sourceCursor).toEqual({
      teamId: "T123",
      selfUserId: "U_SELF",
      lastSyncAt: undefined,
      knownConversationIds: [],
      scan: {
        mode: "full",
        startedAt: expect.any(Number),
        oldestMs: 0,
        usersComplete: true,
        conversationFamily: "channels",
        conversationCursor: null,
      },
    });
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
      knownConversationIds: [],
    });
  });

  it("keeps incremental Slack syncs bounded to the last sync window", async () => {
    const historyOldestValues: string[] = [];
    const listedTypes: string[] = [];
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
        async listConversations(types) {
          listedTypes.push(types);
          if (types === "im,mpim") {
            return {
              conversations: [
                {
                  id: "D123",
                  is_im: true,
                },
              ],
              nextCursor: "ignored-im-next-cursor",
            };
          }

          return {
            conversations: [
              {
                id: "C123",
                is_channel: true,
              },
            ],
            nextCursor: "ignored-channel-next-cursor",
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

    expect(listedTypes).toEqual(["im,mpim", "public_channel,private_channel"]);
    expect(historyOldestValues).toEqual([expectedOldest, expectedOldest]);
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
        async listConversations(types) {
          if (types === "im,mpim") {
            return {
              conversations: [
                {
                  id: "D123",
                  is_im: true,
                  latest: {
                    type: "message",
                    text: "Recent DM update",
                    ts: "1710000301.000000",
                  },
                },
              ],
              nextCursor: "page-2-im",
            };
          }

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
            nextCursor: "page-2-channel",
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

  it("continues full scans from direct conversations into channels", async () => {
    const listedTypes: string[] = [];
    const bundle = await buildSlackSyncBundle({
      accountKey: "default",
      client: {
        async testAuth() {
          return { ok: true, team_id: "T123", user_id: "U_SELF", team: "Acme", user: "Ava" };
        },
        async listUsers() {
          return { users: [], nextCursor: undefined };
        },
        async listConversations(types) {
          listedTypes.push(types);
          if (types === "im,mpim") {
            return {
              conversations: [],
              nextCursor: "",
            };
          }

          return {
            conversations: [],
            nextCursor: undefined,
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

    expect(listedTypes).toEqual(["im,mpim"]);
    expect(bundle.hasMore).toBe(true);
    expect(bundle.sourceCursor).toEqual({
      teamId: "T123",
      selfUserId: "U_SELF",
      lastSyncAt: undefined,
      knownConversationIds: [],
      scan: {
        mode: "full",
        startedAt: expect.any(Number),
        oldestMs: 0,
        usersComplete: true,
        conversationFamily: "channels",
        conversationCursor: null,
      },
    });
  });

  it("resumes old mixed scan cursors in the channel family", async () => {
    const listedTypes: string[] = [];
    await buildSlackSyncBundle({
      accountKey: "default",
      sourceCursor: {
        teamId: "T123",
        selfUserId: "U_SELF",
        scan: {
          mode: "full",
          startedAt: 1710000000000,
          oldestMs: 0,
          usersComplete: true,
          conversationCursor: "team:legacy-cursor",
        },
      },
      client: {
        async testAuth() {
          return { ok: true, team_id: "T123", user_id: "U_SELF", team: "Acme", user: "Ava" };
        },
        async listUsers() {
          return { users: [], nextCursor: undefined };
        },
        async listConversations(types) {
          listedTypes.push(types);
          return {
            conversations: [],
            nextCursor: undefined,
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

    expect(listedTypes).toEqual(["public_channel,private_channel"]);
  });

  it("resumes full syncs within a conversation history pagination chain", async () => {
    const getHistory = async (_conversationId: string, options?: { cursor?: string }) => {
      if (!options?.cursor) {
        return {
          messages: [
            {
              type: "message",
              user: "U_BEN",
              text: "page one",
              ts: "1710000000.000100",
            },
          ],
          hasMore: true,
          nextCursor: "history-2",
        };
      }

      return {
        messages: [
          {
            type: "message",
            user: "U_BEN",
            text: "page two",
            ts: "1710000000.000200",
          },
        ],
        hasMore: false,
        nextCursor: undefined,
      };
    };

    const first = await buildSlackSyncBundle({
      accountKey: "default",
      apiPageBudget: 1,
      sourceCursor: {
        teamId: "T123",
        selfUserId: "U_SELF",
        scan: {
          mode: "full",
          startedAt: 1710000000000,
          oldestMs: 0,
          usersComplete: true,
          conversationFamily: "channels",
          conversationCursor: null,
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
            conversations: [{ id: "C123", is_channel: true }],
            nextCursor: undefined,
          };
        },
        async getConversationMembers() {
          return { members: [], nextCursor: undefined };
        },
        getHistory,
        async getReplies() {
          return { messages: [], hasMore: false, nextCursor: undefined };
        },
      },
    });

    expect(first.hasMore).toBe(true);
    expect(first.rawEvents.filter((event) => event.entityKind === "message")).toHaveLength(1);
    expect(first.sourceCursor).toEqual({
      teamId: "T123",
      selfUserId: "U_SELF",
      lastSyncAt: undefined,
      knownConversationIds: ["C123"],
      scan: {
        mode: "full",
        startedAt: 1710000000000,
        oldestMs: 0,
        usersComplete: true,
        conversationFamily: "channels",
        conversationCursor: null,
        conversationIndex: 0,
        activeConversationId: "C123",
        historyCursor: "history-2",
        historyComplete: false,
        conversationPhase: "history",
        threadRootCount: 0,
        completedThreadCount: 0,
        pendingThreadTs: [],
        activeThreadTs: null,
        repliesCursor: null,
      },
    });

    const second = await buildSlackSyncBundle({
      accountKey: "default",
      apiPageBudget: 1,
      sourceCursor: first.sourceCursor,
      client: {
        async testAuth() {
          return { ok: true, team_id: "T123", user_id: "U_SELF", team: "Acme", user: "Ava" };
        },
        async listUsers() {
          return { users: [], nextCursor: undefined };
        },
        async listConversations() {
          return {
            conversations: [{ id: "C123", is_channel: true }],
            nextCursor: undefined,
          };
        },
        async getConversationMembers() {
          return { members: [], nextCursor: undefined };
        },
        getHistory,
        async getReplies() {
          return { messages: [], hasMore: false, nextCursor: undefined };
        },
      },
    });

    expect(second.hasMore).toBe(false);
    expect(second.rawEvents.filter((event) => event.entityKind === "message")).toHaveLength(1);
    expect(second.sourceCursor).toEqual({
      teamId: "T123",
      selfUserId: "U_SELF",
      lastSyncAt: 1710000000000,
      knownConversationIds: ["C123"],
    });
  });

  it("resumes full syncs within thread reply pagination", async () => {
    const getReplies = async (
      _conversationId: string,
      _threadTs: string,
      options?: { cursor?: string },
    ) => {
      if (!options?.cursor) {
        return {
          messages: [
            {
              type: "message",
              user: "U_BEN",
              text: "reply one",
              ts: "1710000000.000200",
              thread_ts: "1710000000.000100",
            },
          ],
          hasMore: true,
          nextCursor: "reply-2",
        };
      }

      return {
        messages: [
          {
            type: "message",
            user: "U_BEN",
            text: "reply two",
            ts: "1710000000.000300",
            thread_ts: "1710000000.000100",
          },
        ],
        hasMore: false,
        nextCursor: undefined,
      };
    };

    const first = await buildSlackSyncBundle({
      accountKey: "default",
      apiPageBudget: 2,
      sourceCursor: {
        teamId: "T123",
        selfUserId: "U_SELF",
        scan: {
          mode: "full",
          startedAt: 1710000000000,
          oldestMs: 0,
          usersComplete: true,
          conversationFamily: "channels",
          conversationCursor: null,
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
            conversations: [{ id: "C123", is_channel: true }],
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
                text: "thread root",
                ts: "1710000000.000100",
                reply_count: 2,
              },
            ],
            hasMore: false,
            nextCursor: undefined,
          };
        },
        getReplies,
      },
    });

    expect(first.hasMore).toBe(true);
    expect(first.rawEvents.filter((event) => event.entityKind === "message")).toHaveLength(2);
    expect(first.sourceCursor).toEqual({
      teamId: "T123",
      selfUserId: "U_SELF",
      lastSyncAt: undefined,
      knownConversationIds: ["C123"],
      scan: {
        mode: "full",
        startedAt: 1710000000000,
        oldestMs: 0,
        usersComplete: true,
        conversationFamily: "channels",
        conversationCursor: null,
        conversationIndex: 0,
        activeConversationId: "C123",
        historyCursor: null,
        historyComplete: true,
        conversationPhase: "threads",
        threadRootCount: 1,
        completedThreadCount: 0,
        pendingThreadTs: [],
        activeThreadTs: "1710000000.000100",
        repliesCursor: "reply-2",
      },
    });

    const second = await buildSlackSyncBundle({
      accountKey: "default",
      apiPageBudget: 2,
      sourceCursor: first.sourceCursor,
      client: {
        async testAuth() {
          return { ok: true, team_id: "T123", user_id: "U_SELF", team: "Acme", user: "Ava" };
        },
        async listUsers() {
          return { users: [], nextCursor: undefined };
        },
        async listConversations() {
          return {
            conversations: [{ id: "C123", is_channel: true }],
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
                text: "thread root",
                ts: "1710000000.000100",
                reply_count: 2,
              },
            ],
            hasMore: false,
            nextCursor: undefined,
          };
        },
        getReplies,
      },
    });

    expect(second.hasMore).toBe(false);
    expect(second.rawEvents.filter((event) => event.entityKind === "message")).toHaveLength(1);
    expect(second.diagnostics?.slackBackfillConversations).toEqual([
      expect.objectContaining({
        conversationId: "C123",
        conversationPhase: "complete",
        threadRootCount: 1,
        completedThreadCount: 1,
        pendingThreadCount: 0,
      }),
    ]);
    expect(second.proofs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          proofKind: "messages",
          status: "complete",
          scope: expect.objectContaining({
            kind: "conversation",
            key: "C123",
          }),
        }),
        expect.objectContaining({
          proofKind: "replies",
          status: "complete",
          scope: expect.objectContaining({
            kind: "conversation",
            key: "C123",
          }),
        }),
      ]),
    );
  });

  it("finishes top-level history before entering thread backfill", async () => {
    const calls: string[] = [];

    const first = await buildSlackSyncBundle({
      accountKey: "default",
      apiPageBudget: 1,
      sourceCursor: {
        teamId: "T123",
        selfUserId: "U_SELF",
        scan: {
          mode: "full",
          startedAt: 1710000000000,
          oldestMs: 0,
          usersComplete: true,
          conversationFamily: "channels",
          conversationCursor: null,
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
            conversations: [{ id: "C123", is_channel: true }],
            nextCursor: undefined,
          };
        },
        async getConversationMembers() {
          return { members: [], nextCursor: undefined };
        },
        async getHistory(_conversationId, options) {
          calls.push(`history:${options?.cursor ?? "start"}`);
          return !options?.cursor
            ? {
                messages: [
                  {
                    type: "message",
                    user: "U_BEN",
                    text: "page one",
                    ts: "1710000000.000100",
                    reply_count: 1,
                  },
                ],
                hasMore: true,
                nextCursor: "history-2",
              }
            : {
                messages: [
                  {
                    type: "message",
                    user: "U_BEN",
                    text: "page two",
                    ts: "1710000000.000200",
                  },
                ],
                hasMore: false,
                nextCursor: undefined,
              };
        },
        async getReplies() {
          calls.push("replies");
          return { messages: [], hasMore: false, nextCursor: undefined };
        },
      },
    });

    expect(calls).toEqual(["history:start"]);
    expect(first.sourceCursor).toEqual(
      expect.objectContaining({
        scan: expect.objectContaining({
          conversationPhase: "history",
          historyCursor: "history-2",
          pendingThreadTs: ["1710000000.000100"],
          activeThreadTs: null,
        }),
      }),
    );
  });

  it("fetches all channel history during full sync by default", async () => {
    const historyOldestValues: string[] = [];

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

    expect(historyOldestValues).toEqual([""]);
  });

  it("fetches newly discovered conversations during incremental sync even when their latest activity is old", async () => {
    const fetchedHistories: string[] = [];

    const bundle = await buildSlackSyncBundle({
      accountKey: "default",
      lastSyncAt: 1_710_000_400_000,
      sourceCursor: {
        teamId: "T123",
        selfUserId: "U_SELF",
        lastSyncAt: 1_710_000_400_000,
        knownConversationIds: ["D_KNOWN"],
      },
      client: {
        async testAuth() {
          return { ok: true, team_id: "T123", user_id: "U_SELF", team: "Acme", user: "Ava" };
        },
        async listUsers() {
          return { users: [], nextCursor: undefined };
        },
        async listConversations(types) {
          if (types === "im,mpim") {
            return {
              conversations: [
                {
                  id: "D_KNOWN",
                  is_im: true,
                  user: "U_BEN",
                  latest: {
                    type: "message",
                    user: "U_BEN",
                    text: "old known",
                    ts: "1710000000.000100",
                  },
                },
                {
                  id: "D_NEW",
                  is_im: true,
                  user: "U_CARA",
                  latest: {
                    type: "message",
                    user: "U_CARA",
                    text: "old new",
                    ts: "1710000000.000200",
                  },
                },
              ],
              nextCursor: undefined,
            };
          }
          return {
            conversations: [],
            nextCursor: undefined,
          };
        },
        async getConversationMembers() {
          return { members: [], nextCursor: undefined };
        },
        async getHistory(conversationId) {
          fetchedHistories.push(conversationId);
          return {
            messages:
              conversationId === "D_NEW"
                ? [
                    {
                      type: "message",
                      user: "U_CARA",
                      text: "historic DM from a newly discovered thread",
                      ts: "1710000000.000200",
                    },
                  ]
                : [],
            hasMore: false,
            nextCursor: undefined,
          };
        },
        async getReplies() {
          return { messages: [], hasMore: false, nextCursor: undefined };
        },
      },
    });

    expect(fetchedHistories).toEqual(["D_NEW"]);
    expect(
      bundle.rawEvents.some(
        (event) =>
          event.entityKind === "message" &&
          (event.payload as Record<string, unknown>).sourceConversationKey === "slack:T123:D_NEW",
      ),
    ).toBe(true);
    expect(bundle.sourceCursor).toEqual(
      expect.objectContaining({
        knownConversationIds: ["D_KNOWN", "D_NEW"],
      }),
    );
  });
});
