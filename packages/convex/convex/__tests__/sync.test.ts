/**
 * Tests for Convex sync functions.
 *
 * Uses convex-test to mock the Convex backend and test
 * iMessage, Gmail, and Slack sync operations.
 *
 * Note: Sync mutations schedule background functions (contact resolution, action events)
 * that may generate warnings after test completion. This is expected behavior as the
 * tests focus on the synchronous mutation results rather than background processing.
 */

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../schema";
import { modules } from "./test.setup";
import {
  createTestUserData,
  createTestContactData,
  createTestContactHandleData,
  createTestConversationData,
  createTestMessageData,
  createTestIdentity,
  createTestIntegrationData,
} from "./helpers";
import { api } from "../_generated/api";

/**
 * Helper to set up an authenticated test environment.
 * Creates a user in the database that matches the identity.
 */
async function setupAuthenticatedUser(t: ReturnType<typeof convexTest>) {
  const identity = createTestIdentity();
  const asUser = t.withIdentity(identity);

  // Create user in database with matching workosUserId
  const userId = await t.run(async (ctx) => {
    return ctx.db.insert("users", createTestUserData({
      workosUserId: identity.subject,
      pendingActionCount: 0,
    }));
  });

  return { asUser, userId, identity };
}

describe("sync", () => {
  // ============================================================================
  // iMessage Sync Tests (syncMessages)
  // ============================================================================
  describe("syncMessages mutation (iMessage)", () => {
    it("throws for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      await expect(
        t.mutation(api.sync.syncMessages, {
          batch: {
            cursor: 0,
            chats: [],
            messages: [],
            handles: [],
          },
        })
      ).rejects.toThrow("Unauthorized");
    });

    it("syncs new conversation from iMessage chat", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const result = await asUser.mutation(api.sync.syncMessages, {
        batch: {
          cursor: 100,
          chats: [
            {
              id: 1,
              identifier: "chat_1",
              displayName: null,
              isGroup: false,
              participants: [
                { id: 1, identifier: "+15551234567", service: "iMessage" },
              ],
            },
          ],
          messages: [],
          handles: [
            { id: 1, identifier: "+15551234567", service: "iMessage" },
          ],
        },
      });

      expect(result.chatsCount).toBe(1);
      expect(result.cursor).toBe(100);

      // Verify conversation was created
      const conversations = await t.run(async (ctx) => {
        return ctx.db
          .query("conversations")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(conversations).toHaveLength(1);
      expect(conversations[0].platform).toBe("imessage");
      expect(conversations[0].platformConversationId).toBe("1");
    });

    it("syncs new messages and updates conversation lastMessage", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const timestamp = Math.floor(Date.now() / 1000);

      const result = await asUser.mutation(api.sync.syncMessages, {
        batch: {
          cursor: 100,
          chats: [
            {
              id: 1,
              identifier: "chat_1",
              displayName: null,
              isGroup: false,
              participants: [
                { id: 1, identifier: "+15551234567", service: "iMessage" },
              ],
            },
          ],
          messages: [
            {
              id: 1,
              chatId: 1,
              text: "Hello there!",
              timestamp,
              isFromMe: false,
              isRead: true,
              readAt: null,
              hasAttachments: false,
              sender: { id: 1, identifier: "+15551234567", service: "iMessage" },
            },
          ],
          handles: [
            { id: 1, identifier: "+15551234567", service: "iMessage" },
          ],
        },
      });

      expect(result.messagesCount).toBe(1);
      expect(result.chatsCount).toBe(1);

      // Verify message was created
      const messages = await t.run(async (ctx) => {
        return ctx.db
          .query("messages")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Hello there!");
      expect(messages[0].isFromMe).toBe(false);
      expect(messages[0].platform).toBe("imessage");

      // Verify conversation lastMessage was updated
      const conversations = await t.run(async (ctx) => {
        return ctx.db
          .query("conversations")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(conversations[0].lastMessageText).toBe("Hello there!");
      expect(conversations[0].lastMessageAt).toBe(timestamp * 1000);
    });

    it("creates placeholder contact for unknown sender", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await asUser.mutation(api.sync.syncMessages, {
        batch: {
          cursor: 100,
          chats: [
            {
              id: 1,
              identifier: "chat_1",
              displayName: null,
              isGroup: false,
              participants: [
                { id: 1, identifier: "+15559876543", service: "iMessage" },
              ],
            },
          ],
          messages: [
            {
              id: 1,
              chatId: 1,
              text: "New message",
              timestamp: Math.floor(Date.now() / 1000),
              isFromMe: false,
              isRead: true,
              readAt: null,
              hasAttachments: false,
              sender: { id: 1, identifier: "+15559876543", service: "iMessage" },
            },
          ],
          handles: [
            { id: 1, identifier: "+15559876543", service: "iMessage" },
          ],
        },
      });

      // Verify placeholder contact was created
      const contacts = await t.run(async (ctx) => {
        return ctx.db
          .query("contacts")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(contacts).toHaveLength(1);
      expect(contacts[0].displayName).toBe("+15559876543");

      // Verify handle was created
      const handles = await t.run(async (ctx) => {
        return ctx.db
          .query("contactHandles")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(handles).toHaveLength(1);
      expect(handles[0].handleType).toBe("phone");
    });

    it("resolves existing contact by phone number", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create existing contact with handle
      const contactId = await t.run(async (ctx) => {
        const id = await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Alice Smith",
        }));
        await ctx.db.insert("contactHandles", createTestContactHandleData(userId, id, {
          handleType: "phone",
          handle: "+15551234567",
          platform: "imessage",
        }));
        return id;
      });

      await asUser.mutation(api.sync.syncMessages, {
        batch: {
          cursor: 100,
          chats: [
            {
              id: 1,
              identifier: "chat_1",
              displayName: null,
              isGroup: false,
              participants: [
                { id: 1, identifier: "+15551234567", service: "iMessage" },
              ],
            },
          ],
          messages: [
            {
              id: 1,
              chatId: 1,
              text: "Message from known contact",
              timestamp: Math.floor(Date.now() / 1000),
              isFromMe: false,
              isRead: true,
              readAt: null,
              hasAttachments: false,
              sender: { id: 1, identifier: "+15551234567", service: "iMessage" },
            },
          ],
          handles: [
            { id: 1, identifier: "+15551234567", service: "iMessage" },
          ],
        },
      });

      // Verify message references existing contact
      const messages = await t.run(async (ctx) => {
        return ctx.db
          .query("messages")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(messages[0].senderContactId).toBe(contactId);

      // Verify no new contact was created
      const contacts = await t.run(async (ctx) => {
        return ctx.db
          .query("contacts")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(contacts).toHaveLength(1);
    });

    it("deduplicates messages by platformMessageId", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // First sync - should create message
      const result1 = await asUser.mutation(api.sync.syncMessages, {
        batch: {
          cursor: 100,
          chats: [
            {
              id: 1,
              identifier: "chat_1",
              displayName: null,
              isGroup: false,
              participants: [
                { id: 1, identifier: "+15551234567", service: "iMessage" },
              ],
            },
          ],
          messages: [
            {
              id: 42,
              chatId: 1,
              text: "Original message",
              timestamp: Math.floor(Date.now() / 1000),
              isFromMe: true,
              isRead: true,
              readAt: null,
              hasAttachments: false,
              sender: null,
            },
          ],
          handles: [
            { id: 1, identifier: "+15551234567", service: "iMessage" },
          ],
        },
      });

      expect(result1.messagesCount).toBe(1);

      // Second sync with same message ID - should skip
      const result2 = await asUser.mutation(api.sync.syncMessages, {
        batch: {
          cursor: 200,
          chats: [],
          messages: [
            {
              id: 42, // Same ID
              chatId: 1,
              text: "Duplicate message",
              timestamp: Math.floor(Date.now() / 1000),
              isFromMe: true,
              isRead: true,
              readAt: null,
              hasAttachments: false,
              sender: null,
            },
          ],
          handles: [],
        },
      });

      expect(result2.messagesCount).toBe(0);

      // Verify only one message exists
      const messages = await t.run(async (ctx) => {
        return ctx.db
          .query("messages")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Original message");
    });

    it("handles group chat with multiple participants", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await asUser.mutation(api.sync.syncMessages, {
        batch: {
          cursor: 100,
          chats: [
            {
              id: 1,
              identifier: "group_chat_1",
              displayName: "Family Group",
              isGroup: true,
              participants: [
                { id: 1, identifier: "+15551111111", service: "iMessage" },
                { id: 2, identifier: "+15552222222", service: "iMessage" },
                { id: 3, identifier: "+15553333333", service: "iMessage" },
              ],
            },
          ],
          messages: [],
          handles: [
            { id: 1, identifier: "+15551111111", service: "iMessage" },
            { id: 2, identifier: "+15552222222", service: "iMessage" },
            { id: 3, identifier: "+15553333333", service: "iMessage" },
          ],
        },
      });

      // Verify conversation is group type with display name
      const conversations = await t.run(async (ctx) => {
        return ctx.db
          .query("conversations")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(conversations).toHaveLength(1);
      expect(conversations[0].conversationType).toBe("group");
      expect(conversations[0].displayName).toBe("Family Group");
      expect(conversations[0].participantContactIds).toHaveLength(3);
    });

    it("handles messages with email handles", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await asUser.mutation(api.sync.syncMessages, {
        batch: {
          cursor: 100,
          chats: [
            {
              id: 1,
              identifier: "chat_1",
              displayName: null,
              isGroup: false,
              participants: [
                { id: 1, identifier: "user@example.com", service: "iMessage" },
              ],
            },
          ],
          messages: [
            {
              id: 1,
              chatId: 1,
              text: "Email-based iMessage",
              timestamp: Math.floor(Date.now() / 1000),
              isFromMe: false,
              isRead: true,
              readAt: null,
              hasAttachments: false,
              sender: { id: 1, identifier: "user@example.com", service: "iMessage" },
            },
          ],
          handles: [
            { id: 1, identifier: "user@example.com", service: "iMessage" },
          ],
        },
      });

      // Verify handle was created with email type
      const handles = await t.run(async (ctx) => {
        return ctx.db
          .query("contactHandles")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(handles).toHaveLength(1);
      expect(handles[0].handleType).toBe("email");
    });
  });

  // ============================================================================
  // Gmail Sync Tests (syncGmailMessages)
  // ============================================================================
  describe("syncGmailMessages mutation", () => {
    it("throws for unknown user", async () => {
      const t = convexTest(schema, modules);

      await expect(
        t.mutation(api.sync.syncGmailMessages, {
          workosUserId: "unknown_user",
          emails: [],
        })
      ).rejects.toThrow("User not found");
    });

    it("syncs Gmail email and creates conversation", async () => {
      const t = convexTest(schema, modules);

      // Create user (no auth context for webhook mutations)
      const { userId, workosUserId } = await t.run(async (ctx) => {
        const userData = createTestUserData();
        const id = await ctx.db.insert("users", userData);
        return { userId: id, workosUserId: userData.workosUserId };
      });

      const result = await t.mutation(api.sync.syncGmailMessages, {
        workosUserId,
        emails: [
          {
            id: "msg_1",
            sender: "Alice Smith <alice@example.com>",
            recipients: "me@example.com",
            date: new Date().toISOString(),
            subject: "Meeting tomorrow",
            body: "Let's discuss the project.",
            attachments: [],
            threadId: "thread_1",
          },
        ],
      });

      expect(result.messagesCount).toBe(1);
      expect(result.conversationsCount).toBe(1);

      // Verify conversation was created
      const conversations = await t.run(async (ctx) => {
        return ctx.db
          .query("conversations")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(conversations).toHaveLength(1);
      expect(conversations[0].platform).toBe("gmail");
      expect(conversations[0].platformConversationId).toBe("thread_1");
      expect(conversations[0].displayName).toBe("Meeting tomorrow");
    });

    it("creates contact from email sender", async () => {
      const t = convexTest(schema, modules);

      const { userId, workosUserId } = await t.run(async (ctx) => {
        const userData = createTestUserData();
        const id = await ctx.db.insert("users", userData);
        return { userId: id, workosUserId: userData.workosUserId };
      });

      await t.mutation(api.sync.syncGmailMessages, {
        workosUserId,
        emails: [
          {
            id: "msg_1",
            sender: "Bob Jones <bob@company.com>",
            recipients: "me@example.com",
            date: new Date().toISOString(),
            subject: "Hello",
            body: "Test email",
            attachments: [],
            threadId: "thread_1",
          },
        ],
      });

      // Verify contact was created with display name
      const contacts = await t.run(async (ctx) => {
        return ctx.db
          .query("contacts")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(contacts).toHaveLength(1);
      expect(contacts[0].displayName).toBe("Bob Jones");

      // Verify handle was created
      const handles = await t.run(async (ctx) => {
        return ctx.db
          .query("contactHandles")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(handles).toHaveLength(1);
      expect(handles[0].handle).toBe("bob@company.com");
      expect(handles[0].platform).toBe("gmail");
    });

    it("skips newsletter emails", async () => {
      const t = convexTest(schema, modules);

      const { workosUserId } = await t.run(async (ctx) => {
        const userData = createTestUserData();
        await ctx.db.insert("users", userData);
        return { workosUserId: userData.workosUserId };
      });

      const result = await t.mutation(api.sync.syncGmailMessages, {
        workosUserId,
        emails: [
          {
            id: "msg_1",
            sender: "noreply@newsletter.com",
            recipients: "me@example.com",
            date: new Date().toISOString(),
            subject: "[Newsletter] Weekly Digest",
            body: "Newsletter content",
            attachments: [],
            threadId: "thread_1",
          },
        ],
      });

      expect(result.messagesCount).toBe(0);
      expect(result.skippedNewsletters).toBe(1);
    });

    it("deduplicates Gmail messages by id", async () => {
      const t = convexTest(schema, modules);

      const { userId, workosUserId } = await t.run(async (ctx) => {
        const userData = createTestUserData();
        const id = await ctx.db.insert("users", userData);
        return { userId: id, workosUserId: userData.workosUserId };
      });

      // First sync
      const result1 = await t.mutation(api.sync.syncGmailMessages, {
        workosUserId,
        emails: [
          {
            id: "msg_unique_1",
            sender: "sender@example.com",
            recipients: "me@example.com",
            date: new Date().toISOString(),
            subject: "Original",
            body: "Original body",
            attachments: [],
            threadId: "thread_1",
          },
        ],
      });

      expect(result1.messagesCount).toBe(1);

      // Second sync with same message ID
      const result2 = await t.mutation(api.sync.syncGmailMessages, {
        workosUserId,
        emails: [
          {
            id: "msg_unique_1", // Same ID
            sender: "sender@example.com",
            recipients: "me@example.com",
            date: new Date().toISOString(),
            subject: "Duplicate",
            body: "Should be skipped",
            attachments: [],
            threadId: "thread_1",
          },
        ],
      });

      expect(result2.messagesCount).toBe(0);

      // Verify only one message exists
      const messages = await t.run(async (ctx) => {
        return ctx.db
          .query("messages")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(messages).toHaveLength(1);
    });

    it("groups emails by thread and updates conversation", async () => {
      const t = convexTest(schema, modules);

      const { userId, workosUserId } = await t.run(async (ctx) => {
        const userData = createTestUserData();
        const id = await ctx.db.insert("users", userData);
        return { userId: id, workosUserId: userData.workosUserId };
      });

      const now = Date.now();
      const earlier = now - 3600000; // 1 hour earlier

      const result = await t.mutation(api.sync.syncGmailMessages, {
        workosUserId,
        emails: [
          {
            id: "msg_1",
            sender: "Alice <alice@example.com>",
            recipients: "me@example.com",
            date: new Date(earlier).toISOString(),
            subject: "Thread subject",
            body: "First message",
            attachments: [],
            threadId: "thread_1",
          },
          {
            id: "msg_2",
            sender: "Alice <alice@example.com>",
            recipients: "me@example.com",
            date: new Date(now).toISOString(),
            subject: "Re: Thread subject",
            body: "Second message",
            attachments: [],
            threadId: "thread_1", // Same thread
          },
        ],
      });

      expect(result.messagesCount).toBe(2);
      expect(result.conversationsCount).toBe(1); // One conversation for the thread

      // Verify conversation has latest message
      const conversations = await t.run(async (ctx) => {
        return ctx.db
          .query("conversations")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(conversations[0].lastMessageText).toBe("Re: Thread subject");
    });
  });

  // ============================================================================
  // Slack Sync Tests (syncSlackMessages)
  // ============================================================================
  describe("syncSlackMessages mutation", () => {
    it("throws for unknown user", async () => {
      const t = convexTest(schema, modules);

      await expect(
        t.mutation(api.sync.syncSlackMessages, {
          workosUserId: "unknown_user",
          messages: [],
        })
      ).rejects.toThrow("User not found");
    });

    it("syncs Slack DM message and creates conversation", async () => {
      const t = convexTest(schema, modules);

      const { userId, workosUserId } = await t.run(async (ctx) => {
        const userData = createTestUserData();
        const id = await ctx.db.insert("users", userData);
        return { userId: id, workosUserId: userData.workosUserId };
      });

      const result = await t.mutation(api.sync.syncSlackMessages, {
        workosUserId,
        messages: [
          {
            id: "msg_1",
            channelId: "D12345678",
            channelType: "im",
            channelName: "alice",
            userId: "U12345678",
            userName: "Alice Smith",
            text: "Hey, how's it going?",
            ts: "1234567890.123456",
            isThreadParent: false,
            isBot: false,
            sentAt: new Date().toISOString(),
          },
        ],
      });

      expect(result.messagesCount).toBe(1);
      expect(result.conversationsCount).toBe(1);

      // Verify conversation
      const conversations = await t.run(async (ctx) => {
        return ctx.db
          .query("conversations")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(conversations).toHaveLength(1);
      expect(conversations[0].platform).toBe("slack");
      expect(conversations[0].conversationType).toBe("dm");
      expect(conversations[0].displayName).toBe("alice");
    });

    it("creates contact with Slack user ID handle", async () => {
      const t = convexTest(schema, modules);

      const { userId, workosUserId } = await t.run(async (ctx) => {
        const userData = createTestUserData();
        const id = await ctx.db.insert("users", userData);
        return { userId: id, workosUserId: userData.workosUserId };
      });

      await t.mutation(api.sync.syncSlackMessages, {
        workosUserId,
        messages: [
          {
            id: "msg_1",
            channelId: "D12345678",
            channelType: "im",
            userId: "U87654321",
            userName: "Bob Wilson",
            text: "Hello!",
            ts: "1234567890.123456",
            isThreadParent: false,
            isBot: false,
            sentAt: new Date().toISOString(),
          },
        ],
      });

      // Verify contact was created
      const contacts = await t.run(async (ctx) => {
        return ctx.db
          .query("contacts")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(contacts).toHaveLength(1);
      expect(contacts[0].displayName).toBe("Bob Wilson");

      // Verify handle
      const handles = await t.run(async (ctx) => {
        return ctx.db
          .query("contactHandles")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(handles).toHaveLength(1);
      expect(handles[0].handleType).toBe("slack_id");
      expect(handles[0].handle).toBe("U87654321");
      expect(handles[0].platform).toBe("slack");
    });

    it("skips bot messages", async () => {
      const t = convexTest(schema, modules);

      const { workosUserId } = await t.run(async (ctx) => {
        const userData = createTestUserData();
        await ctx.db.insert("users", userData);
        return { workosUserId: userData.workosUserId };
      });

      const result = await t.mutation(api.sync.syncSlackMessages, {
        workosUserId,
        messages: [
          {
            id: "msg_1",
            channelId: "C12345678",
            channelType: "channel",
            userId: "B12345678", // Bot user
            text: "Bot message",
            ts: "1234567890.123456",
            isThreadParent: false,
            isBot: true,
            sentAt: new Date().toISOString(),
          },
        ],
      });

      expect(result.messagesCount).toBe(0);
    });

    it("handles channel conversation type", async () => {
      const t = convexTest(schema, modules);

      const { userId, workosUserId } = await t.run(async (ctx) => {
        const userData = createTestUserData();
        const id = await ctx.db.insert("users", userData);
        return { userId: id, workosUserId: userData.workosUserId };
      });

      await t.mutation(api.sync.syncSlackMessages, {
        workosUserId,
        messages: [
          {
            id: "msg_1",
            channelId: "C12345678",
            channelType: "channel",
            channelName: "general",
            userId: "U12345678",
            text: "Channel message",
            ts: "1234567890.123456",
            isThreadParent: false,
            isBot: false,
            sentAt: new Date().toISOString(),
          },
        ],
      });

      const conversations = await t.run(async (ctx) => {
        return ctx.db
          .query("conversations")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(conversations[0].conversationType).toBe("channel");
      expect(conversations[0].displayName).toBe("general");
    });

    it("handles mpim (multi-party IM) as group", async () => {
      const t = convexTest(schema, modules);

      const { userId, workosUserId } = await t.run(async (ctx) => {
        const userData = createTestUserData();
        const id = await ctx.db.insert("users", userData);
        return { userId: id, workosUserId: userData.workosUserId };
      });

      await t.mutation(api.sync.syncSlackMessages, {
        workosUserId,
        messages: [
          {
            id: "msg_1",
            channelId: "G12345678",
            channelType: "mpim",
            channelName: "alice-bob-charlie",
            userId: "U12345678",
            text: "Group DM message",
            ts: "1234567890.123456",
            isThreadParent: false,
            isBot: false,
            sentAt: new Date().toISOString(),
          },
        ],
      });

      const conversations = await t.run(async (ctx) => {
        return ctx.db
          .query("conversations")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(conversations[0].conversationType).toBe("group");
    });

    it("deduplicates Slack messages by ts", async () => {
      const t = convexTest(schema, modules);

      const { userId, workosUserId } = await t.run(async (ctx) => {
        const userData = createTestUserData();
        const id = await ctx.db.insert("users", userData);
        return { userId: id, workosUserId: userData.workosUserId };
      });

      // First sync
      const result1 = await t.mutation(api.sync.syncSlackMessages, {
        workosUserId,
        messages: [
          {
            id: "msg_1",
            channelId: "C12345678",
            channelType: "channel",
            userId: "U12345678",
            text: "Original",
            ts: "1234567890.000001",
            isThreadParent: false,
            isBot: false,
            sentAt: new Date().toISOString(),
          },
        ],
      });

      expect(result1.messagesCount).toBe(1);

      // Second sync with same ts
      const result2 = await t.mutation(api.sync.syncSlackMessages, {
        workosUserId,
        messages: [
          {
            id: "msg_1",
            channelId: "C12345678",
            channelType: "channel",
            userId: "U12345678",
            text: "Duplicate",
            ts: "1234567890.000001", // Same ts
            isThreadParent: false,
            isBot: false,
            sentAt: new Date().toISOString(),
          },
        ],
      });

      expect(result2.messagesCount).toBe(0);

      // Verify only one message
      const messages = await t.run(async (ctx) => {
        return ctx.db
          .query("messages")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(messages).toHaveLength(1);
    });

    it("stores thread information", async () => {
      const t = convexTest(schema, modules);

      const { userId, workosUserId } = await t.run(async (ctx) => {
        const userData = createTestUserData();
        const id = await ctx.db.insert("users", userData);
        return { userId: id, workosUserId: userData.workosUserId };
      });

      await t.mutation(api.sync.syncSlackMessages, {
        workosUserId,
        messages: [
          {
            id: "msg_1",
            channelId: "C12345678",
            channelType: "channel",
            userId: "U12345678",
            text: "Thread parent",
            ts: "1234567890.000001",
            isThreadParent: true,
            isBot: false,
            sentAt: new Date().toISOString(),
          },
          {
            id: "msg_2",
            channelId: "C12345678",
            channelType: "channel",
            userId: "U12345678",
            text: "Thread reply",
            ts: "1234567890.000002",
            threadTs: "1234567890.000001",
            isThreadParent: false,
            isBot: false,
            sentAt: new Date().toISOString(),
          },
        ],
      });

      const messages = await t.run(async (ctx) => {
        return ctx.db
          .query("messages")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      // Find the thread reply
      const threadReply = messages.find(m => m.content === "Thread reply");
      expect(threadReply?.threadTs).toBe("1234567890.000001");
      expect(threadReply?.isThreadParent).toBe(false);

      // Find the parent
      const threadParent = messages.find(m => m.content === "Thread parent");
      expect(threadParent?.isThreadParent).toBe(true);
    });

    it("stores reactions on messages", async () => {
      const t = convexTest(schema, modules);

      const { userId, workosUserId } = await t.run(async (ctx) => {
        const userData = createTestUserData();
        const id = await ctx.db.insert("users", userData);
        return { userId: id, workosUserId: userData.workosUserId };
      });

      await t.mutation(api.sync.syncSlackMessages, {
        workosUserId,
        messages: [
          {
            id: "msg_1",
            channelId: "C12345678",
            channelType: "channel",
            userId: "U12345678",
            text: "Message with reactions",
            ts: "1234567890.000001",
            isThreadParent: false,
            isBot: false,
            sentAt: new Date().toISOString(),
            reactions: [
              { name: "thumbsup", count: 2, users: ["U111", "U222"] },
              { name: "heart", count: 1, users: ["U333"] },
            ],
          },
        ],
      });

      const messages = await t.run(async (ctx) => {
        return ctx.db
          .query("messages")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(messages[0].reactions).toHaveLength(2);
      expect(messages[0].reactions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ emoji: ":thumbsup:" }),
          expect.objectContaining({ emoji: ":heart:" }),
        ])
      );
    });
  });

  // ============================================================================
  // Contact Resolution Tests
  // ============================================================================
  describe("contact resolution during sync", () => {
    it("resolves contact by normalized email across platforms", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create contact with gmail handle
      const contactId = await t.run(async (ctx) => {
        const id = await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Alice",
        }));
        await ctx.db.insert("contactHandles", createTestContactHandleData(userId, id, {
          handleType: "email",
          handle: "alice@gmail.com",
          platform: "gmail",
        }));
        return id;
      });

      // Sync iMessage with same email (different casing)
      await asUser.mutation(api.sync.syncMessages, {
        batch: {
          cursor: 100,
          chats: [
            {
              id: 1,
              identifier: "chat_1",
              displayName: null,
              isGroup: false,
              participants: [
                { id: 1, identifier: "ALICE@gmail.com", service: "iMessage" },
              ],
            },
          ],
          messages: [
            {
              id: 1,
              chatId: 1,
              text: "Test",
              timestamp: Math.floor(Date.now() / 1000),
              isFromMe: false,
              isRead: true,
              readAt: null,
              hasAttachments: false,
              sender: { id: 1, identifier: "ALICE@gmail.com", service: "iMessage" },
            },
          ],
          handles: [
            { id: 1, identifier: "ALICE@gmail.com", service: "iMessage" },
          ],
        },
      });

      // Verify message linked to existing contact
      const messages = await t.run(async (ctx) => {
        return ctx.db
          .query("messages")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(messages[0].senderContactId).toBe(contactId);
    });

    it("creates new contact when no handle match found", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Sync message from unknown sender
      await asUser.mutation(api.sync.syncMessages, {
        batch: {
          cursor: 100,
          chats: [
            {
              id: 1,
              identifier: "chat_1",
              displayName: null,
              isGroup: false,
              participants: [
                { id: 1, identifier: "+15559999999", service: "iMessage" },
              ],
            },
          ],
          messages: [
            {
              id: 1,
              chatId: 1,
              text: "Hello",
              timestamp: Math.floor(Date.now() / 1000),
              isFromMe: false,
              isRead: true,
              readAt: null,
              hasAttachments: false,
              sender: { id: 1, identifier: "+15559999999", service: "iMessage" },
            },
          ],
          handles: [
            { id: 1, identifier: "+15559999999", service: "iMessage" },
          ],
        },
      });

      // Verify new contact and handle were created
      const contacts = await t.run(async (ctx) => {
        return ctx.db
          .query("contacts")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(contacts).toHaveLength(1);

      const handles = await t.run(async (ctx) => {
        return ctx.db
          .query("contactHandles")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(handles).toHaveLength(1);
      expect(handles[0].contactId).toBe(contacts[0]._id);
    });
  });

  // ============================================================================
  // Sync Cursor Management Tests
  // ============================================================================
  describe("getSyncCursor query", () => {
    it("returns null for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      const result = await t.query(api.sync.getSyncCursor, {
        platform: "imessage",
      });

      expect(result).toBeNull();
    });

    it("returns default cursor when no integration exists", async () => {
      const t = convexTest(schema, modules);
      const { asUser } = await setupAuthenticatedUser(t);

      const result = await asUser.query(api.sync.getSyncCursor, {
        platform: "imessage",
      });

      expect(result).toEqual({
        cursor: "0",
        lastSyncAt: null,
      });
    });

    it("returns cursor from existing integration", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const lastSyncAt = Date.now();

      await t.run(async (ctx) => {
        await ctx.db.insert("integrations", {
          userId,
          platform: "imessage",
          syncState: {
            isConnected: true,
            lastSyncCursor: "12345",
            lastSyncAt,
          },
        });
      });

      const result = await asUser.query(api.sync.getSyncCursor, {
        platform: "imessage",
      });

      expect(result).toEqual({
        cursor: "12345",
        lastSyncAt,
      });
    });
  });

  describe("updateSyncCursor mutation", () => {
    it("throws for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      await expect(
        t.mutation(api.sync.updateSyncCursor, {
          platform: "imessage",
          cursor: "100",
        })
      ).rejects.toThrow("Unauthorized");
    });

    it("creates integration and sets cursor", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await asUser.mutation(api.sync.updateSyncCursor, {
        platform: "imessage",
        cursor: "500",
      });

      const integration = await t.run(async (ctx) => {
        return ctx.db
          .query("integrations")
          .withIndex("by_user_platform", (q) =>
            q.eq("userId", userId).eq("platform", "imessage")
          )
          .unique();
      });

      expect(integration?.syncState.lastSyncCursor).toBe("500");
      expect(integration?.syncState.lastSyncAt).toBeGreaterThan(0);
    });

    it("updates existing integration cursor", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create existing integration
      await t.run(async (ctx) => {
        await ctx.db.insert("integrations", {
          userId,
          platform: "imessage",
          syncState: {
            isConnected: true,
            lastSyncCursor: "100",
          },
        });
      });

      await asUser.mutation(api.sync.updateSyncCursor, {
        platform: "imessage",
        cursor: "200",
      });

      const integration = await t.run(async (ctx) => {
        return ctx.db
          .query("integrations")
          .withIndex("by_user_platform", (q) =>
            q.eq("userId", userId).eq("platform", "imessage")
          )
          .unique();
      });

      expect(integration?.syncState.lastSyncCursor).toBe("200");
    });
  });

  describe("resetSyncState mutation", () => {
    it("resets integration sync state", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create integration with existing state
      await t.run(async (ctx) => {
        await ctx.db.insert("integrations", {
          userId,
          platform: "imessage",
          syncState: {
            isConnected: true,
            lastSyncCursor: "99999",
            lastSyncAt: Date.now(),
            totalMessagesSynced: 1000,
            totalContactsSynced: 50,
          },
        });
      });

      await asUser.mutation(api.sync.resetSyncState, {
        platform: "imessage",
      });

      const integration = await t.run(async (ctx) => {
        return ctx.db
          .query("integrations")
          .withIndex("by_user_platform", (q) =>
            q.eq("userId", userId).eq("platform", "imessage")
          )
          .unique();
      });

      expect(integration?.syncState.lastSyncCursor).toBe("0");
      expect(integration?.syncState.totalMessagesSynced).toBe(0);
      expect(integration?.syncState.totalContactsSynced).toBe(0);
    });
  });
});
