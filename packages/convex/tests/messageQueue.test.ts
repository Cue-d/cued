/**
 * Tests for messageQueue mutations and queries.
 *
 * Uses convex-test to mock the Convex backend and test
 * queue operations in isolation.
 */

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { modules } from "./test.setup";
import { createTestUserData, createTestIdentity } from "./helpers.util";
import { useSchedulerCleanup } from "./schedulerCleanup.util";
import { api } from "../convex/_generated/api";

const { trackTest } = useSchedulerCleanup();

/** Helper to set up an authenticated test environment */
async function setupAuthenticatedUser(t: ReturnType<typeof convexTest>) {
  const identity = createTestIdentity();
  const asUser = t.withIdentity(identity);

  const userId = await t.run(async (ctx) => {
    return ctx.db.insert(
      "users",
      createTestUserData({
        workosUserId: identity.subject,
      })
    );
  });

  return { asUser, userId, identity };
}

describe("messageQueue", () => {
  // ============================================================================
  // MUTATIONS
  // ============================================================================

  describe("queueMessage mutation", () => {
    it("throws for unauthenticated user", async () => {
      const t = trackTest(convexTest(schema, modules));

      await expect(
        t.mutation(api.messageQueue.queueMessage, {
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Hello!",
          isGroup: false,
        })
      ).rejects.toThrow("Unauthorized");
    });

    it("queues message with 30s delay (undo window)", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser } = await setupAuthenticatedUser(t);

      const before = Date.now();
      const result = await asUser.mutation(api.messageQueue.queueMessage, {
        platform: "imessage",
        recipientHandle: "+15551234567",
        text: "Hello!",
        isGroup: false,
      });
      const after = Date.now();

      expect(result.messageId).toBeTruthy();
      expect(result.scheduledFor).toBeTruthy();

      // scheduledFor should be ~30s from now
      const expectedMin = before + 30 * 1000;
      const expectedMax = after + 30 * 1000;
      expect(result.scheduledFor).toBeGreaterThanOrEqual(expectedMin);
      expect(result.scheduledFor).toBeLessThanOrEqual(expectedMax);

      // Verify the message was created correctly
      const message = await t.run(async (ctx) =>
        ctx.db.get(result.messageId)
      );
      expect(message?.status).toBe("pending");
      expect(message?.attempts).toBe(0);
      expect(message?.platform).toBe("imessage");
      expect(message?.text).toBe("Hello!");
    });

    it("queues message with all optional fields", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create a contact for the optional field
      const contactId = await t.run(async (ctx) => {
        return ctx.db.insert("contacts", {
          userId,
          displayName: "Test Contact",
        });
      });

      const result = await asUser.mutation(api.messageQueue.queueMessage, {
        platform: "linkedin",
        recipientHandle: "john-doe-123",
        recipientContactId: contactId,
        text: "Great connecting!",
        isGroup: false,
        chatIdentifier: "chat_123",
      });

      const message = await t.run(async (ctx) =>
        ctx.db.get(result.messageId)
      );
      expect(message?.platform).toBe("linkedin");
      expect(message?.recipientContactId).toEqual(contactId);
      expect(message?.chatIdentifier).toBe("chat_123");
    });

    it("queues group message", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser } = await setupAuthenticatedUser(t);

      const result = await asUser.mutation(api.messageQueue.queueMessage, {
        platform: "imessage",
        recipientHandle: "group-chat-id",
        text: "Hey everyone!",
        isGroup: true,
        chatIdentifier: "chat;-;group-chat-id",
      });

      const message = await t.run(async (ctx) =>
        ctx.db.get(result.messageId)
      );
      expect(message?.isGroup).toBe(true);
      expect(message?.chatIdentifier).toBe("chat;-;group-chat-id");
    });

    it("resolves LinkedIn chatIdentifier from conversationId when missing", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const contactId = await t.run(async (ctx) => {
        return ctx.db.insert("contacts", {
          userId,
          displayName: "LinkedIn Contact",
        });
      });

      const conversationId = await t.run(async (ctx) => {
        return ctx.db.insert("conversations", {
          userId,
          platform: "linkedin",
          platformConversationId: "urn:li:fsd_conversation:abc123",
          conversationType: "dm",
          participantContactIds: [contactId],
          unreadCount: 0,
          lastMessageAt: Date.now(),
        });
      });

      const result = await asUser.mutation(api.messageQueue.queueMessage, {
        platform: "linkedin",
        recipientHandle: "linkedin-handle",
        recipientContactId: contactId,
        conversationId,
        text: "Hello!",
        isGroup: false,
      });

      const message = await t.run(async (ctx) => ctx.db.get(result.messageId));
      expect(message?.conversationId).toEqual(conversationId);
      expect(message?.chatIdentifier).toBe("urn:li:fsd_conversation:abc123");
    });

    it("resolves LinkedIn conversation from recipientContactId when conversationId missing", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const contactId = await t.run(async (ctx) => {
        return ctx.db.insert("contacts", {
          userId,
          displayName: "LinkedIn Contact",
        });
      });

      const now = Date.now();
      await t.run(async (ctx) => {
        await ctx.db.insert("conversations", {
          userId,
          platform: "linkedin",
          platformConversationId: "urn:li:fsd_conversation:older",
          conversationType: "dm",
          participantContactIds: [contactId],
          unreadCount: 0,
          lastMessageAt: now - 1000,
        });
      });
      const newerConversationId = await t.run(async (ctx) => {
        return ctx.db.insert("conversations", {
          userId,
          platform: "linkedin",
          platformConversationId: "urn:li:fsd_conversation:newer",
          conversationType: "dm",
          participantContactIds: [contactId],
          unreadCount: 0,
          lastMessageAt: now,
        });
      });

      const result = await asUser.mutation(api.messageQueue.queueMessage, {
        platform: "linkedin",
        recipientHandle: "linkedin-handle",
        recipientContactId: contactId,
        text: "Hello!",
        isGroup: false,
      });

      const message = await t.run(async (ctx) => ctx.db.get(result.messageId));
      expect(message?.conversationId).toEqual(newerConversationId);
      expect(message?.chatIdentifier).toBe("urn:li:fsd_conversation:newer");
    });

    it("throws when LinkedIn thread cannot be resolved", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser } = await setupAuthenticatedUser(t);

      await expect(
        asUser.mutation(api.messageQueue.queueMessage, {
          platform: "linkedin",
          recipientHandle: "linkedin-handle",
          text: "Hello!",
          isGroup: false,
        })
      ).rejects.toThrow(
        "LinkedIn messages require an existing conversation"
      );
    });
  });

  describe("cancelMessage mutation", () => {
    it("throws for unauthenticated user", async () => {
      const t = trackTest(convexTest(schema, modules));

      // Create a message to try to cancel
      const messageId = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());
        return ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Hello!",
          isGroup: false,
          status: "pending",
          scheduledFor: Date.now() + 30000,
          attempts: 0,
          createdAt: Date.now(),
        });
      });

      await expect(
        t.mutation(api.messageQueue.cancelMessage, { messageId })
      ).rejects.toThrow("Unauthorized");
    });

    it("cancels a pending message", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const messageId = await t.run(async (ctx) => {
        return ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Hello!",
          isGroup: false,
          status: "pending",
          scheduledFor: Date.now() + 30000,
          attempts: 0,
          createdAt: Date.now(),
        });
      });

      const result = await asUser.mutation(api.messageQueue.cancelMessage, {
        messageId,
      });

      expect(result.success).toBe(true);

      const message = await t.run(async (ctx) => ctx.db.get(messageId));
      expect(message?.status).toBe("cancelled");
      expect(message?.cancelledAt).toBeTruthy();
    });

    it("throws when trying to cancel non-pending message", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create a message that's already sent
      const messageId = await t.run(async (ctx) => {
        return ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Hello!",
          isGroup: false,
          status: "sent",
          scheduledFor: Date.now(),
          attempts: 1,
          createdAt: Date.now(),
          sentAt: Date.now(),
        });
      });

      await expect(
        asUser.mutation(api.messageQueue.cancelMessage, { messageId })
      ).rejects.toThrow("Can only cancel pending messages");
    });

    it("throws when message belongs to different user", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser } = await setupAuthenticatedUser(t);

      // Create a message for a different user
      const messageId = await t.run(async (ctx) => {
        const otherUserId = await ctx.db.insert(
          "users",
          createTestUserData({ workosUserId: "other_user" })
        );
        return ctx.db.insert("messageQueue", {
          userId: otherUserId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Hello!",
          isGroup: false,
          status: "pending",
          scheduledFor: Date.now() + 30000,
          attempts: 0,
          createdAt: Date.now(),
        });
      });

      await expect(
        asUser.mutation(api.messageQueue.cancelMessage, { messageId })
      ).rejects.toThrow("Message not found");
    });

    it("throws for cancelled message", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const messageId = await t.run(async (ctx) => {
        return ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Hello!",
          isGroup: false,
          status: "cancelled",
          scheduledFor: Date.now() + 30000,
          attempts: 0,
          createdAt: Date.now(),
          cancelledAt: Date.now(),
        });
      });

      await expect(
        asUser.mutation(api.messageQueue.cancelMessage, { messageId })
      ).rejects.toThrow("Can only cancel pending messages");
    });
  });

  describe("updateMessageStatus mutation", () => {
    it("throws for unauthenticated user", async () => {
      const t = trackTest(convexTest(schema, modules));

      const messageId = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());
        return ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Hello!",
          isGroup: false,
          status: "pending",
          scheduledFor: Date.now(),
          attempts: 0,
          createdAt: Date.now(),
        });
      });

      await expect(
        t.mutation(api.messageQueue.updateMessageStatus, {
          messageId,
          status: "sent",
        })
      ).rejects.toThrow("Unauthorized");
    });

    it("updates status to sending and increments attempts", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const messageId = await t.run(async (ctx) => {
        return ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Hello!",
          isGroup: false,
          status: "pending",
          scheduledFor: Date.now(),
          attempts: 0,
          createdAt: Date.now(),
        });
      });

      const result = await asUser.mutation(
        api.messageQueue.updateMessageStatus,
        {
          messageId,
          status: "sending",
        }
      );

      expect(result.success).toBe(true);

      const message = await t.run(async (ctx) => ctx.db.get(messageId));
      expect(message?.status).toBe("sending");
      expect(message?.attempts).toBe(1);
      expect(message?.lastAttemptAt).toBeTruthy();
    });

    it("updates status to sent with sentAt timestamp", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const messageId = await t.run(async (ctx) => {
        return ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Hello!",
          isGroup: false,
          status: "sending",
          scheduledFor: Date.now(),
          attempts: 1,
          createdAt: Date.now(),
        });
      });

      const result = await asUser.mutation(
        api.messageQueue.updateMessageStatus,
        {
          messageId,
          status: "sent",
        }
      );

      expect(result.success).toBe(true);

      const message = await t.run(async (ctx) => ctx.db.get(messageId));
      expect(message?.status).toBe("sent");
      expect(message?.sentAt).toBeTruthy();
    });

    it("auto-retries failed message under max attempts", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const messageId = await t.run(async (ctx) => {
        return ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Hello!",
          isGroup: false,
          status: "sending",
          scheduledFor: Date.now(),
          attempts: 1, // Under max attempts (3)
          createdAt: Date.now(),
        });
      });

      const result = await asUser.mutation(
        api.messageQueue.updateMessageStatus,
        {
          messageId,
          status: "failed",
          error: "Network error",
        }
      );

      expect(result.success).toBe(true);
      expect(result.willRetry).toBe(true);

      const message = await t.run(async (ctx) => ctx.db.get(messageId));
      // Should be reset to pending for retry
      expect(message?.status).toBe("pending");
      expect(message?.error).toBe("Network error");
    });

    it("marks as failed when max attempts reached", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const messageId = await t.run(async (ctx) => {
        return ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Hello!",
          isGroup: false,
          status: "sending",
          scheduledFor: Date.now(),
          attempts: 3, // At max attempts
          createdAt: Date.now(),
        });
      });

      const result = await asUser.mutation(
        api.messageQueue.updateMessageStatus,
        {
          messageId,
          status: "failed",
          error: "Permanent failure",
        }
      );

      expect(result.success).toBe(true);
      expect(result.willRetry).toBe(false);

      const message = await t.run(async (ctx) => ctx.db.get(messageId));
      expect(message?.status).toBe("failed");
      expect(message?.error).toBe("Permanent failure");
    });

    it("throws when message belongs to different user", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser } = await setupAuthenticatedUser(t);

      const messageId = await t.run(async (ctx) => {
        const otherUserId = await ctx.db.insert(
          "users",
          createTestUserData({ workosUserId: "other_user" })
        );
        return ctx.db.insert("messageQueue", {
          userId: otherUserId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Hello!",
          isGroup: false,
          status: "pending",
          scheduledFor: Date.now(),
          attempts: 0,
          createdAt: Date.now(),
        });
      });

      await expect(
        asUser.mutation(api.messageQueue.updateMessageStatus, {
          messageId,
          status: "sent",
        })
      ).rejects.toThrow("Message not found");
    });
  });

  describe("retryMessage mutation", () => {
    it("throws for unauthenticated user", async () => {
      const t = trackTest(convexTest(schema, modules));

      const messageId = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());
        return ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Hello!",
          isGroup: false,
          status: "failed",
          scheduledFor: Date.now(),
          attempts: 3,
          createdAt: Date.now(),
          error: "Failed to send",
        });
      });

      await expect(
        t.mutation(api.messageQueue.retryMessage, { messageId })
      ).rejects.toThrow("Unauthorized");
    });

    it("retries failed message - resets attempts and status", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const messageId = await t.run(async (ctx) => {
        return ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Hello!",
          isGroup: false,
          status: "failed",
          scheduledFor: Date.now() - 60000, // old scheduled time
          attempts: 3,
          createdAt: Date.now() - 120000,
          error: "Network error",
        });
      });

      const before = Date.now();
      const result = await asUser.mutation(api.messageQueue.retryMessage, {
        messageId,
      });
      const after = Date.now();

      expect(result.success).toBe(true);

      const message = await t.run(async (ctx) => ctx.db.get(messageId));
      expect(message?.status).toBe("pending");
      expect(message?.attempts).toBe(0);
      expect(message?.error).toBeUndefined();
      // Should be scheduled for immediate send
      expect(message?.scheduledFor).toBeGreaterThanOrEqual(before);
      expect(message?.scheduledFor).toBeLessThanOrEqual(after);
    });

    it("throws when trying to retry non-failed message", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const messageId = await t.run(async (ctx) => {
        return ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Hello!",
          isGroup: false,
          status: "pending",
          scheduledFor: Date.now() + 30000,
          attempts: 0,
          createdAt: Date.now(),
        });
      });

      await expect(
        asUser.mutation(api.messageQueue.retryMessage, { messageId })
      ).rejects.toThrow("Can only retry failed messages");
    });

    it("throws when message belongs to different user", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser } = await setupAuthenticatedUser(t);

      const messageId = await t.run(async (ctx) => {
        const otherUserId = await ctx.db.insert(
          "users",
          createTestUserData({ workosUserId: "other_user" })
        );
        return ctx.db.insert("messageQueue", {
          userId: otherUserId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Hello!",
          isGroup: false,
          status: "failed",
          scheduledFor: Date.now(),
          attempts: 3,
          createdAt: Date.now(),
          error: "Failed",
        });
      });

      await expect(
        asUser.mutation(api.messageQueue.retryMessage, { messageId })
      ).rejects.toThrow("Message not found");
    });
  });

  // ============================================================================
  // QUERIES
  // ============================================================================

  describe("getQueuedMessages query", () => {
    it("returns empty array for unauthenticated user", async () => {
      const t = trackTest(convexTest(schema, modules));

      const result = await t.query(api.messageQueue.getQueuedMessages, {});

      expect(result).toEqual({ messages: [] });
    });

    it("returns messages where scheduledFor < now (past undo window)", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();

      await t.run(async (ctx) => {
        // Message past undo window - should be returned
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Ready to send",
          isGroup: false,
          status: "pending",
          scheduledFor: now - 1000, // 1s ago
          attempts: 0,
          createdAt: now - 31000,
        });

        // Message still in undo window - should NOT be returned
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15559876543",
          text: "Still in undo window",
          isGroup: false,
          status: "pending",
          scheduledFor: now + 20000, // 20s from now
          attempts: 0,
          createdAt: now,
        });
      });

      const result = await asUser.query(api.messageQueue.getQueuedMessages, {});

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].text).toBe("Ready to send");
    });

    it("only returns pending messages", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();
      const pastTime = now - 1000;

      await t.run(async (ctx) => {
        // Pending - should be returned
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Pending message",
          isGroup: false,
          status: "pending",
          scheduledFor: pastTime,
          attempts: 0,
          createdAt: now - 31000,
        });

        // Sent - should NOT be returned
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15559876543",
          text: "Already sent",
          isGroup: false,
          status: "sent",
          scheduledFor: pastTime,
          attempts: 1,
          createdAt: now - 60000,
          sentAt: now - 30000,
        });

        // Cancelled - should NOT be returned
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551111111",
          text: "Cancelled message",
          isGroup: false,
          status: "cancelled",
          scheduledFor: pastTime,
          attempts: 0,
          createdAt: now - 31000,
          cancelledAt: now - 20000,
        });
      });

      const result = await asUser.query(api.messageQueue.getQueuedMessages, {});

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].text).toBe("Pending message");
    });

    it("filters by platform when specified", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();
      const pastTime = now - 1000;

      await t.run(async (ctx) => {
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "iMessage",
          isGroup: false,
          status: "pending",
          scheduledFor: pastTime,
          attempts: 0,
          createdAt: now - 31000,
        });

        await ctx.db.insert("messageQueue", {
          userId,
          platform: "linkedin",
          recipientHandle: "john-doe",
          text: "LinkedIn message",
          isGroup: false,
          status: "pending",
          scheduledFor: pastTime,
          attempts: 0,
          createdAt: now - 31000,
        });
      });

      const result = await asUser.query(api.messageQueue.getQueuedMessages, {
        platform: "linkedin",
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].platform).toBe("linkedin");
    });

    it("respects limit parameter", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();
      const pastTime = now - 1000;

      await t.run(async (ctx) => {
        for (let i = 0; i < 5; i++) {
          await ctx.db.insert("messageQueue", {
            userId,
            platform: "imessage",
            recipientHandle: `+1555123456${i}`,
            text: `Message ${i}`,
            isGroup: false,
            status: "pending",
            scheduledFor: pastTime - i * 1000, // Different times
            attempts: 0,
            createdAt: now - 31000,
          });
        }
      });

      const result = await asUser.query(api.messageQueue.getQueuedMessages, {
        limit: 2,
      });

      expect(result.messages).toHaveLength(2);
    });

    it("sorts by scheduledFor (oldest first)", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();

      await t.run(async (ctx) => {
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Newer",
          isGroup: false,
          status: "pending",
          scheduledFor: now - 1000, // More recent
          attempts: 0,
          createdAt: now - 31000,
        });

        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15559876543",
          text: "Older",
          isGroup: false,
          status: "pending",
          scheduledFor: now - 10000, // Older
          attempts: 0,
          createdAt: now - 40000,
        });
      });

      const result = await asUser.query(api.messageQueue.getQueuedMessages, {});

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].text).toBe("Older");
      expect(result.messages[1].text).toBe("Newer");
    });
  });

  describe("getPendingMessages query", () => {
    it("returns empty array for unauthenticated user", async () => {
      const t = trackTest(convexTest(schema, modules));

      const result = await t.query(api.messageQueue.getPendingMessages, {});

      expect(result).toEqual({ messages: [] });
    });

    it("returns messages still in undo window (scheduledFor > now)", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();

      await t.run(async (ctx) => {
        // In undo window - should be returned
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "In undo window",
          isGroup: false,
          status: "pending",
          scheduledFor: now + 20000, // 20s from now
          attempts: 0,
          createdAt: now,
        });

        // Past undo window - should NOT be returned
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15559876543",
          text: "Past undo window",
          isGroup: false,
          status: "pending",
          scheduledFor: now - 1000, // 1s ago
          attempts: 0,
          createdAt: now - 31000,
        });
      });

      const result = await asUser.query(api.messageQueue.getPendingMessages, {});

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].text).toBe("In undo window");
    });

    it("includes timeRemainingMs for each message", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();
      const scheduledFor = now + 15000; // 15s from now

      await t.run(async (ctx) => {
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Test",
          isGroup: false,
          status: "pending",
          scheduledFor,
          attempts: 0,
          createdAt: now,
        });
      });

      const result = await asUser.query(api.messageQueue.getPendingMessages, {});

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].timeRemainingMs).toBeDefined();
      // Should be approximately 15s, but allow for test execution time
      expect(result.messages[0].timeRemainingMs).toBeGreaterThan(0);
      expect(result.messages[0].timeRemainingMs).toBeLessThanOrEqual(15000);
    });

    it("only returns pending status messages", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();
      const futureTime = now + 20000;

      await t.run(async (ctx) => {
        // Pending - should be returned
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Pending",
          isGroup: false,
          status: "pending",
          scheduledFor: futureTime,
          attempts: 0,
          createdAt: now,
        });

        // Cancelled (even if in future) - should NOT be returned
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15559876543",
          text: "Cancelled",
          isGroup: false,
          status: "cancelled",
          scheduledFor: futureTime,
          attempts: 0,
          createdAt: now,
          cancelledAt: now,
        });
      });

      const result = await asUser.query(api.messageQueue.getPendingMessages, {});

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].text).toBe("Pending");
    });
  });

  describe("getMessageQueueStats query", () => {
    it("returns zeros for unauthenticated user", async () => {
      const t = trackTest(convexTest(schema, modules));

      const result = await t.query(api.messageQueue.getMessageQueueStats, {});

      expect(result).toEqual({
        pending: 0,
        sending: 0,
        sent: 0,
        failed: 0,
        cancelled: 0,
        total: 0,
      });
    });

    it("returns correct counts by status", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();

      await t.run(async (ctx) => {
        // 2 pending
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+1",
          text: "1",
          isGroup: false,
          status: "pending",
          scheduledFor: now + 30000,
          attempts: 0,
          createdAt: now,
        });
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+2",
          text: "2",
          isGroup: false,
          status: "pending",
          scheduledFor: now + 30000,
          attempts: 0,
          createdAt: now,
        });

        // 1 sending
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+3",
          text: "3",
          isGroup: false,
          status: "sending",
          scheduledFor: now,
          attempts: 1,
          createdAt: now - 31000,
        });

        // 3 sent
        for (let i = 0; i < 3; i++) {
          await ctx.db.insert("messageQueue", {
            userId,
            platform: "imessage",
            recipientHandle: `+${4 + i}`,
            text: `${4 + i}`,
            isGroup: false,
            status: "sent",
            scheduledFor: now - 60000,
            attempts: 1,
            createdAt: now - 90000,
            sentAt: now - 60000,
          });
        }

        // 1 failed
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+7",
          text: "7",
          isGroup: false,
          status: "failed",
          scheduledFor: now,
          attempts: 3,
          createdAt: now - 120000,
          error: "Failed",
        });

        // 1 cancelled
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+8",
          text: "8",
          isGroup: false,
          status: "cancelled",
          scheduledFor: now + 30000,
          attempts: 0,
          createdAt: now,
          cancelledAt: now,
        });
      });

      const result = await asUser.query(
        api.messageQueue.getMessageQueueStats,
        {}
      );

      expect(result).toEqual({
        pending: 2,
        sending: 1,
        sent: 3,
        failed: 1,
        cancelled: 1,
        total: 8,
      });
    });

    it("only counts messages for authenticated user", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();

      await t.run(async (ctx) => {
        // User's message
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+1",
          text: "My message",
          isGroup: false,
          status: "pending",
          scheduledFor: now + 30000,
          attempts: 0,
          createdAt: now,
        });

        // Other user's message
        const otherUserId = await ctx.db.insert(
          "users",
          createTestUserData({ workosUserId: "other" })
        );
        await ctx.db.insert("messageQueue", {
          userId: otherUserId,
          platform: "imessage",
          recipientHandle: "+2",
          text: "Other's message",
          isGroup: false,
          status: "pending",
          scheduledFor: now + 30000,
          attempts: 0,
          createdAt: now,
        });
      });

      const result = await asUser.query(
        api.messageQueue.getMessageQueueStats,
        {}
      );

      expect(result.total).toBe(1);
      expect(result.pending).toBe(1);
    });
  });
});
