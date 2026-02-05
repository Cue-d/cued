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
import schema from "../convex/schema";
import { modules } from "./test.setup";
import {
  createTestUserData,
  createTestContactData,
  createTestContactHandleData,
  createTestConversationData,
  createTestMessageData,
  createTestIdentity,
  createTestIntegrationData,
} from "./helpers.util";
import { useSchedulerCleanup } from "./schedulerCleanup.util";
import { api } from "../convex/_generated/api";

const { trackTest } = useSchedulerCleanup();

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
      const t = trackTest(convexTest(schema, modules));

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
      const t = trackTest(convexTest(schema, modules));
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
      const t = trackTest(convexTest(schema, modules));
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
      const t = trackTest(convexTest(schema, modules));
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
      const t = trackTest(convexTest(schema, modules));
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
      const t = trackTest(convexTest(schema, modules));
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
      const t = trackTest(convexTest(schema, modules));
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
      const t = trackTest(convexTest(schema, modules));
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
      const t = trackTest(convexTest(schema, modules));

      await expect(
        t.mutation(api.sync.syncGmailMessages, {
          workosUserId: "unknown_user",
          emails: [],
        })
      ).rejects.toThrow("User not found");
    });

    it("syncs Gmail email and creates conversation", async () => {
      const t = trackTest(convexTest(schema, modules));

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
      const t = trackTest(convexTest(schema, modules));

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
      const t = trackTest(convexTest(schema, modules));

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
      expect(result.skippedFiltered).toBe(1);
    });

    it("deduplicates Gmail messages by id", async () => {
      const t = trackTest(convexTest(schema, modules));

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
      const t = trackTest(convexTest(schema, modules));

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
  // Contact Resolution Tests
  // ============================================================================
  describe("contact resolution during sync", () => {
    it("resolves contact by normalized email across platforms", async () => {
      const t = trackTest(convexTest(schema, modules));
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
      const t = trackTest(convexTest(schema, modules));
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

    it("resolves phone variant collision - multiple formats map to same contact", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create a contact with phone handle stored as +1 format
      const contactId = await t.run(async (ctx) => {
        const id = await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Alice Smith",
        }));
        // Store the handle with +1 format
        await ctx.db.insert("contactHandles", createTestContactHandleData(userId, id, {
          handleType: "phone",
          handle: "+15551234567",
          platform: "imessage",
        }));
        return id;
      });

      // Sync messages from two different phone format variants of the same number
      // Both should resolve to the same contact Alice Smith
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
                // Format 1: with +1 (same as stored)
                { id: 1, identifier: "+15551234567", service: "iMessage" },
              ],
            },
            {
              id: 2,
              identifier: "chat_2",
              displayName: null,
              isGroup: false,
              participants: [
                // Format 2: 11-digit without + (variant)
                { id: 2, identifier: "15551234567", service: "iMessage" },
              ],
            },
          ],
          messages: [
            {
              id: 1,
              chatId: 1,
              text: "Message from +1 format",
              timestamp: Math.floor(Date.now() / 1000),
              isFromMe: false,
              isRead: true,
              readAt: null,
              hasAttachments: false,
              sender: { id: 1, identifier: "+15551234567", service: "iMessage" },
            },
            {
              id: 2,
              chatId: 2,
              text: "Message from 11-digit format",
              timestamp: Math.floor(Date.now() / 1000),
              isFromMe: false,
              isRead: true,
              readAt: null,
              hasAttachments: false,
              sender: { id: 2, identifier: "15551234567", service: "iMessage" },
            },
          ],
          handles: [
            { id: 1, identifier: "+15551234567", service: "iMessage" },
            { id: 2, identifier: "15551234567", service: "iMessage" },
          ],
        },
      });

      // Verify both messages link to the same existing contact
      const messages = await t.run(async (ctx) => {
        return ctx.db
          .query("messages")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(messages).toHaveLength(2);
      expect(messages[0].senderContactId).toBe(contactId);
      expect(messages[1].senderContactId).toBe(contactId);

      // Verify no new contacts were created (only the original one exists)
      const contacts = await t.run(async (ctx) => {
        return ctx.db
          .query("contacts")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(contacts).toHaveLength(1);
      expect(contacts[0].displayName).toBe("Alice Smith");
    });
  });

  // ============================================================================
  // Sync Cursor Management Tests
  // ============================================================================
  describe("getSyncCursor query", () => {
    it("returns null for unauthenticated user", async () => {
      const t = trackTest(convexTest(schema, modules));

      const result = await t.query(api.sync.getSyncCursor, {
        platform: "imessage",
      });

      expect(result).toBeNull();
    });

    it("returns default cursor when no integration exists", async () => {
      const t = trackTest(convexTest(schema, modules));
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
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const lastSyncAt = Date.now();

      await t.run(async (ctx) => {
        await ctx.db.insert("integrations", {
          userId,
          platform: "imessage",
          isConnected: true,
        });
        await ctx.db.insert("syncCursors", {
          userId,
          platform: "imessage",
          cursorData: { lastSyncCursor: "12345" },
          lastSyncAt,
          syncMode: "incremental",
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
      const t = trackTest(convexTest(schema, modules));

      await expect(
        t.mutation(api.sync.updateSyncCursor, {
          platform: "imessage",
          cursor: "100",
        })
      ).rejects.toThrow("Unauthorized");
    });

    it("creates integration and sets cursor", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await asUser.mutation(api.sync.updateSyncCursor, {
        platform: "imessage",
        cursor: "500",
      });

      const syncCursor = await t.run(async (ctx) => {
        return ctx.db
          .query("syncCursors")
          .withIndex("by_user_platform", (q) =>
            q.eq("userId", userId).eq("platform", "imessage")
          )
          .unique();
      });

      expect(syncCursor?.cursorData?.lastSyncCursor).toBe("500");
      expect(syncCursor?.lastSyncAt).toBeGreaterThan(0);
    });

    it("updates existing integration cursor", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create existing integration and sync cursor
      await t.run(async (ctx) => {
        await ctx.db.insert("integrations", {
          userId,
          platform: "imessage",
          isConnected: true,
        });
        await ctx.db.insert("syncCursors", {
          userId,
          platform: "imessage",
          cursorData: { lastSyncCursor: "100" },
          lastSyncAt: Date.now(),
          syncMode: "incremental",
        });
      });

      await asUser.mutation(api.sync.updateSyncCursor, {
        platform: "imessage",
        cursor: "200",
      });

      const syncCursor = await t.run(async (ctx) => {
        return ctx.db
          .query("syncCursors")
          .withIndex("by_user_platform", (q) =>
            q.eq("userId", userId).eq("platform", "imessage")
          )
          .unique();
      });

      expect(syncCursor?.cursorData?.lastSyncCursor).toBe("200");
    });
  });

  describe("resetSyncState mutation", () => {
    it("resets sync cursor state", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create integration and sync cursor with existing state
      await t.run(async (ctx) => {
        await ctx.db.insert("integrations", {
          userId,
          platform: "imessage",
          isConnected: true,
        });
        await ctx.db.insert("syncCursors", {
          userId,
          platform: "imessage",
          cursorData: { lastSyncCursor: "99999" },
          lastSyncAt: Date.now(),
          syncMode: "incremental",
          totalMessagesSynced: 1000,
          totalContactsSynced: 50,
        });
      });

      await asUser.mutation(api.sync.resetSyncState, {
        platform: "imessage",
      });

      const syncCursor = await t.run(async (ctx) => {
        return ctx.db
          .query("syncCursors")
          .withIndex("by_user_platform", (q) =>
            q.eq("userId", userId).eq("platform", "imessage")
          )
          .unique();
      });

      expect(syncCursor?.cursorData?.lastSyncCursor).toBe("0");
      expect(syncCursor?.totalMessagesSynced).toBe(0);
      expect(syncCursor?.totalContactsSynced).toBe(0);
    });
  });
});
