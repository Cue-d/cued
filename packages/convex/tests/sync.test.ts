/**
 * Tests for Convex sync functions.
 *
 * Uses convex-test to mock the Convex backend and test
 * iMessage, Slack, and other platform sync operations.
 *
 * Note: Sync mutations schedule background functions (contact resolution, action events)
 * that may generate warnings after test completion. This is expected behavior as the
 * tests focus on the synchronous mutation results rather than background processing.
 */

import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
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
import { getOrCreateContact } from "../convex/sync/shared";

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
    return ctx.db.insert(
      "users",
      createTestUserData({
        workosUserId: identity.subject,
        pendingActionCount: 0,
      }),
    );
  });

  return { asUser, userId, identity };
}

describe("sync", () => {
  describe("shared contact resolution scheduling", () => {
    it("schedules event-driven merge checks when displayName improves (shared path)", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        const placeholderContactId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "+15551234567",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, placeholderContactId, {
            handleType: "phone",
            handle: "+15551234567",
            platform: "signal",
          }),
        );

        const namedContactId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Alice Johnson",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, namedContactId, {
            handleType: "email",
            handle: "alice@example.com",
            platform: "signal",
          }),
        );
        await getOrCreateContact(
          ctx,
          userId,
          "signal",
          [{ value: "+15551234567", type: "phone" }],
          "Alice Johnson",
        );
      });

      await t.finishAllScheduledFunctions(() => vi.runOnlyPendingTimers());

      await t.run(async (ctx) => {
        const pendingSuggestions = await ctx.db
          .query("mergeSuggestions")
          .withIndex("by_user_status", (q) =>
            q.eq("userId", userId).eq("status", "pending"),
          )
          .collect();

        expect(pendingSuggestions).toHaveLength(1);
        expect(pendingSuggestions[0].source).toBe("exact_name_match");
      });
    });
  });

  describe("syncContacts — handle-less contact deduplication", () => {
    it("does not create orphan contacts when contact has no phone or email", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Sync a contact with displayName but no handles (e.g., user's own macOS card)
      const result1 = await asUser.mutation(api.sync.syncContacts, {
        contacts: [
          {
            displayName: "theotarr",
            company: null,
            phoneNumbers: [],
            emails: [],
          },
        ],
      });

      expect(result1.contactsCount).toBe(0);
      expect(result1.errors).toHaveLength(0);

      // Sync the same contact again — should still not create any
      const result2 = await asUser.mutation(api.sync.syncContacts, {
        contacts: [
          {
            displayName: "theotarr",
            company: null,
            phoneNumbers: [],
            emails: [],
          },
        ],
      });

      expect(result2.contactsCount).toBe(0);

      // Verify no contacts exist at all
      const contacts = await t.run(async (ctx) => {
        return ctx.db
          .query("contacts")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(contacts).toHaveLength(0);
    });
  });

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
        }),
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
          handles: [{ id: 1, identifier: "+15551234567", service: "iMessage" }],
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
              sender: {
                id: 1,
                identifier: "+15551234567",
                service: "iMessage",
              },
            },
          ],
          handles: [{ id: 1, identifier: "+15551234567", service: "iMessage" }],
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
              sender: {
                id: 1,
                identifier: "+15559876543",
                service: "iMessage",
              },
            },
          ],
          handles: [{ id: 1, identifier: "+15559876543", service: "iMessage" }],
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
        const id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Alice Smith",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, id, {
            handleType: "phone",
            handle: "+15551234567",
            platform: "imessage",
          }),
        );
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
              sender: {
                id: 1,
                identifier: "+15551234567",
                service: "iMessage",
              },
            },
          ],
          handles: [{ id: 1, identifier: "+15551234567", service: "iMessage" }],
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
          handles: [{ id: 1, identifier: "+15551234567", service: "iMessage" }],
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
              sender: {
                id: 1,
                identifier: "user@example.com",
                service: "iMessage",
              },
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

    it("preserves business URNs and uses chat displayName for business DMs", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const businessUrn = "urn:biz:29896aa3-06a9-4b54-b544-5e113c222d08";
      const timestamp = Math.floor(Date.now() / 1000);

      await asUser.mutation(api.sync.syncMessages, {
        batch: {
          cursor: 100,
          chats: [
            {
              id: 1,
              identifier: businessUrn,
              displayName: "Partiful",
              isGroup: false,
              participants: [
                {
                  id: 1,
                  identifier: businessUrn.toUpperCase(),
                  service: "iMessage",
                },
              ],
            },
          ],
          messages: [
            {
              id: 1,
              chatId: 1,
              text: "Welcome to Partiful support",
              timestamp,
              isFromMe: false,
              isRead: true,
              readAt: null,
              hasAttachments: false,
              sender: {
                id: 1,
                identifier: businessUrn.toUpperCase(),
                service: "iMessage",
              },
            },
          ],
          handles: [
            {
              id: 1,
              identifier: businessUrn.toUpperCase(),
              service: "iMessage",
            },
          ],
        },
      });

      const handles = await t.run(async (ctx) => {
        return ctx.db
          .query("contactHandles")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });
      expect(handles).toHaveLength(1);
      expect(handles[0].handleType).toBe("urn");
      expect(handles[0].handle).toBe(businessUrn);

      const contacts = await t.run(async (ctx) => {
        return ctx.db
          .query("contacts")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });
      expect(contacts).toHaveLength(1);
      expect(contacts[0].displayName).toBe("Partiful");

      const conversations = await t.run(async (ctx) => {
        return ctx.db
          .query("conversations")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });
      expect(conversations).toHaveLength(1);
      expect(conversations[0].conversationType).toBe("dm");
      expect(conversations[0].displayName).toBe("Partiful");
      expect(conversations[0].participantContactIds).toEqual([contacts[0]._id]);
    });

    it("backfills business display names for existing contact and conversation", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const businessUrn = "urn:biz:29896aa3-06a9-4b54-b544-5e113c222d08";

      await t.run(async (ctx) => {
        const contactId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: businessUrn }),
        );
        await ctx.db.insert("contactHandles", {
          userId,
          contactId,
          handleType: "urn",
          handle: businessUrn,
          platform: "imessage",
        });
        await ctx.db.insert(
          "conversations",
          createTestConversationData(userId, {
            platform: "imessage",
            platformConversationId: "1",
            conversationType: "dm",
            participantContactIds: [contactId],
          }),
        );
      });

      await asUser.mutation(api.sync.syncMessages, {
        batch: {
          cursor: 200,
          chats: [
            {
              id: 1,
              identifier: businessUrn,
              displayName: "Partiful",
              isGroup: false,
              participants: [
                { id: 1, identifier: businessUrn, service: "iMessage" },
              ],
            },
          ],
          messages: [],
          handles: [{ id: 1, identifier: businessUrn, service: "iMessage" }],
        },
      });

      const contacts = await t.run(async (ctx) => {
        return ctx.db
          .query("contacts")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });
      expect(contacts).toHaveLength(1);
      expect(contacts[0].displayName).toBe("Partiful");

      const conversations = await t.run(async (ctx) => {
        return ctx.db
          .query("conversations")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });
      expect(conversations).toHaveLength(1);
      expect(conversations[0].displayName).toBe("Partiful");
      expect(conversations[0].participantContactIds).toEqual([contacts[0]._id]);
    });
  });

  // ============================================================================
  // Contact Resolution Tests
  // ============================================================================
  describe("contact resolution during sync", () => {
    it("resolves contact by normalized email across platforms", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create contact with email handle
      const contactId = await t.run(async (ctx) => {
        const id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Alice",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, id, {
            handleType: "email",
            handle: "alice@gmail.com",
            platform: "imessage",
          }),
        );
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
              sender: {
                id: 1,
                identifier: "ALICE@gmail.com",
                service: "iMessage",
              },
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
              sender: {
                id: 1,
                identifier: "+15559999999",
                service: "iMessage",
              },
            },
          ],
          handles: [{ id: 1, identifier: "+15559999999", service: "iMessage" }],
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
        const id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Alice Smith",
          }),
        );
        // Store the handle with +1 format
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, id, {
            handleType: "phone",
            handle: "+15551234567",
            platform: "imessage",
          }),
        );
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
              sender: {
                id: 1,
                identifier: "+15551234567",
                service: "iMessage",
              },
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
        }),
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
            q.eq("userId", userId).eq("platform", "imessage"),
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
            q.eq("userId", userId).eq("platform", "imessage"),
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
            q.eq("userId", userId).eq("platform", "imessage"),
          )
          .unique();
      });

      expect(syncCursor?.cursorData?.lastSyncCursor).toBe("0");
      expect(syncCursor?.totalMessagesSynced).toBe(0);
      expect(syncCursor?.totalContactsSynced).toBe(0);
    });
  });
});
