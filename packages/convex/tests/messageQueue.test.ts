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
import {
  createTestUserData,
  createTestIdentity,
  createTestMessageData,
  createTestConversationData,
  createTestContactData,
  createTestActionData,
} from "./helpers.util";
import { useSchedulerCleanup } from "./schedulerCleanup.util";
import { api, internal } from "../convex/_generated/api";

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

    it("queues message for immediate processing", async () => {
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

      // scheduledFor should be effectively now
      const expectedMin = before;
      const expectedMax = after;
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

    it("queues iMessage attachments", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser } = await setupAuthenticatedUser(t);

      const attachments = [
        {
          localPath: "/tmp/image-1.jpg",
          filename: "image-1.jpg",
          mimeType: "image/jpeg",
        },
        {
          localPath: "/tmp/image-2.png",
          filename: "image-2.png",
          mimeType: "image/png",
        },
      ];

      const result = await asUser.mutation(api.messageQueue.queueMessage, {
        platform: "imessage",
        recipientHandle: "+15551234567",
        text: "",
        attachments,
        isGroup: false,
      });

      const message = await t.run(async (ctx) => ctx.db.get(result.messageId));
      expect(message?.attachments).toEqual(attachments);
      expect(message?.text).toBe("");
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

    it("throws when message is claimed by an active processor lease", async () => {
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
          processingDeviceId: "electron-test",
          processingStartedAt: Date.now(),
        });
      });

      await expect(
        asUser.mutation(api.messageQueue.cancelMessage, { messageId })
      ).rejects.toThrow("Message is already being processed");
    });
  });

  describe("claimMessage mutation", () => {
    it("allows one active claimant and blocks a second client", async () => {
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

      const firstClaim = await asUser.mutation(api.messageQueue.claimMessage, {
        messageId,
        deviceId: "electron-client-a",
      });
      const secondClaim = await asUser.mutation(api.messageQueue.claimMessage, {
        messageId,
        deviceId: "electron-client-b",
      });

      expect(firstClaim).toEqual({ success: true, reason: "claimed" });
      expect(secondClaim).toEqual({ success: false, reason: "locked" });

      const message = await t.run(async (ctx) => ctx.db.get(messageId));
      expect(message?.processingDeviceId).toBe("electron-client-a");
      expect(message?.processingStartedAt).toBeTruthy();
    });

    it("lets another client take over after lease expiry", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);
      const now = Date.now();

      const messageId = await t.run(async (ctx) => {
        return ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Hello!",
          isGroup: false,
          status: "pending",
          scheduledFor: now,
          attempts: 0,
          createdAt: now,
          processingDeviceId: "electron-client-a",
          // claim lease is 20s in messageQueue.ts
          processingStartedAt: now - 21_000,
        });
      });

      const claimResult = await asUser.mutation(api.messageQueue.claimMessage, {
        messageId,
        deviceId: "electron-client-b",
      });

      expect(claimResult).toEqual({ success: true, reason: "claimed" });

      const message = await t.run(async (ctx) => ctx.db.get(messageId));
      expect(message?.processingDeviceId).toBe("electron-client-b");
      expect(message?.processingStartedAt).toBeGreaterThanOrEqual(now);
    });

    it("simulates two senders racing to mark the same message as sending", async () => {
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

      const [senderA, senderB] = await Promise.all([
        asUser.mutation(api.messageQueue.updateMessageStatus, {
          messageId,
          status: "sending",
        }),
        asUser.mutation(api.messageQueue.updateMessageStatus, {
          messageId,
          status: "sending",
        }),
      ]);

      const successCount = [senderA, senderB].filter((r) => r.success).length;
      const rejection = [senderA, senderB].find((r) => !r.success);

      expect(successCount).toBe(1);
      expect(rejection?.reason).toBe("not_pending");

      const message = await t.run(async (ctx) => ctx.db.get(messageId));
      expect(message?.status).toBe("sending");
      expect(message?.attempts).toBe(1);
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

    it("marks pending message as failed for pre-send validation failures", async () => {
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
          status: "failed",
          error: "Adapter not authenticated",
        }
      );

      expect(result.success).toBe(true);
      expect(result.willRetry).toBe(false);

      const message = await t.run(async (ctx) => ctx.db.get(messageId));
      expect(message?.status).toBe("failed");
      expect(message?.error).toBe("Adapter not authenticated");
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

    it("rejects sending transition when message is no longer pending", async () => {
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
          scheduledFor: Date.now(),
          attempts: 0,
          createdAt: Date.now(),
          cancelledAt: Date.now(),
        });
      });

      const result = await asUser.mutation(
        api.messageQueue.updateMessageStatus,
        {
          messageId,
          status: "sending",
        }
      );

      expect(result.success).toBe(false);
      const message = await t.run(async (ctx) => ctx.db.get(messageId));
      expect(message?.status).toBe("cancelled");
    });

    it("rejects sending transition when another message in the conversation is already sending", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { blockedMessageId } = await t.run(async (ctx) => {
        const conversationId = await ctx.db.insert(
          "conversations",
          createTestConversationData(userId, { lastMessageAt: Date.now() })
        );

        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15550000001",
          text: "First message",
          isGroup: false,
          conversationId,
          sequenceNumber: 0,
          status: "sending",
          scheduledFor: Date.now() - 1000,
          attempts: 1,
          createdAt: Date.now() - 5000,
          processingStartedAt: Date.now() - 500,
        });

        const blockedMessageId = await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15550000001",
          text: "Second message",
          isGroup: false,
          conversationId,
          sequenceNumber: 1,
          status: "pending",
          scheduledFor: Date.now() - 500,
          attempts: 0,
          createdAt: Date.now() - 3000,
        });

        return { blockedMessageId };
      });

      const result = await asUser.mutation(api.messageQueue.updateMessageStatus, {
        messageId: blockedMessageId,
        status: "sending",
      });

      expect(result.success).toBe(false);
      expect(result.reason).toBe("conversation_locked");

      const message = await t.run(async (ctx) => ctx.db.get(blockedMessageId));
      expect(message?.status).toBe("pending");
      expect(message?.attempts).toBe(0);
    });

    it("allows sending transition when active sender is in a different conversation", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { readyMessageId } = await t.run(async (ctx) => {
        const conversationA = await ctx.db.insert(
          "conversations",
          createTestConversationData(userId, { lastMessageAt: Date.now() - 1000 })
        );
        const conversationB = await ctx.db.insert(
          "conversations",
          createTestConversationData(userId, { lastMessageAt: Date.now() })
        );

        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15550000011",
          text: "Conversation A message",
          isGroup: false,
          conversationId: conversationA,
          sequenceNumber: 0,
          status: "sending",
          scheduledFor: Date.now() - 1000,
          attempts: 1,
          createdAt: Date.now() - 6000,
          processingStartedAt: Date.now() - 1000,
        });

        const readyMessageId = await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15550000022",
          text: "Conversation B message",
          isGroup: false,
          conversationId: conversationB,
          sequenceNumber: 0,
          status: "pending",
          scheduledFor: Date.now() - 500,
          attempts: 0,
          createdAt: Date.now() - 2000,
        });

        return { readyMessageId };
      });

      const result = await asUser.mutation(api.messageQueue.updateMessageStatus, {
        messageId: readyMessageId,
        status: "sending",
      });

      expect(result.success).toBe(true);

      const message = await t.run(async (ctx) => ctx.db.get(readyMessageId));
      expect(message?.status).toBe("sending");
      expect(message?.attempts).toBe(1);
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

    it("retries failed message as a fresh send attempt (time-based ordering)", async () => {
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

    it("returns pending messages where scheduledFor <= now", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();

      await t.run(async (ctx) => {
        // Ready message - should be returned
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

        // Future-scheduled message - should not be returned yet
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15559876543",
          text: "Not ready yet",
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

    it("does not release pending message when same conversation already has sending message", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        const blockedConversationId = await ctx.db.insert(
          "conversations",
          createTestConversationData(userId, { lastMessageAt: Date.now() - 1000 })
        );
        const openConversationId = await ctx.db.insert(
          "conversations",
          createTestConversationData(userId, { lastMessageAt: Date.now() })
        );

        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15550000031",
          text: "Blocked in-flight",
          isGroup: false,
          conversationId: blockedConversationId,
          sequenceNumber: 0,
          status: "sending",
          scheduledFor: Date.now() - 1000,
          attempts: 1,
          createdAt: Date.now() - 5000,
          processingStartedAt: Date.now() - 500,
        });

        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15550000031",
          text: "Should stay queued",
          isGroup: false,
          conversationId: blockedConversationId,
          sequenceNumber: 1,
          status: "pending",
          scheduledFor: Date.now() - 500,
          attempts: 0,
          createdAt: Date.now() - 3000,
        });

        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15550000032",
          text: "Different conversation",
          isGroup: false,
          conversationId: openConversationId,
          sequenceNumber: 0,
          status: "pending",
          scheduledFor: Date.now() - 400,
          attempts: 0,
          createdAt: Date.now() - 2000,
        });
      });

      const result = await asUser.query(api.messageQueue.getQueuedMessages, {});

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].text).toBe("Different conversation");
    });

    it("releases ready message even when an older sequence is still scheduled in the future", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        const conversationId = await ctx.db.insert(
          "conversations",
          createTestConversationData(userId, { lastMessageAt: Date.now() })
        );

        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15550000041",
          text: "Lower sequence (future)",
          isGroup: false,
          conversationId,
          sequenceNumber: 0,
          status: "pending",
          scheduledFor: Date.now() + 30_000,
          attempts: 0,
          createdAt: Date.now() - 3000,
        });

        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15550000041",
          text: "Higher sequence (ready)",
          isGroup: false,
          conversationId,
          sequenceNumber: 1,
          status: "pending",
          scheduledFor: Date.now() - 1000,
          attempts: 0,
          createdAt: Date.now() - 2000,
        });
      });

      const result = await asUser.query(api.messageQueue.getQueuedMessages, {});

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].text).toBe("Higher sequence (ready)");
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

  describe("timeoutStaleSends internal mutation", () => {
    it("keeps pending messages queued during short desktop offline windows", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { userId } = await setupAuthenticatedUser(t);
      const now = Date.now();

      const messageId = await t.run(async (ctx) =>
        ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Waiting with desktop offline",
          isGroup: false,
          status: "pending",
          scheduledFor: now - 20_000,
          attempts: 0,
          createdAt: now - 20_000,
        })
      );

      await t.mutation(internal.messageQueue.timeoutStaleSends, {});

      const message = await t.run(async (ctx) => ctx.db.get(messageId));
      expect(message?.status).toBe("pending");
      expect(message?.error).toBeUndefined();
    });

    it("fails expired pending messages when desktop sender stays offline", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { userId } = await setupAuthenticatedUser(t);
      const now = Date.now();
      const thirteenHoursAgo = now - 13 * 60 * 60 * 1000;

      const messageId = await t.run(async (ctx) =>
        ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Waiting with desktop offline too long",
          isGroup: false,
          status: "pending",
          scheduledFor: thirteenHoursAgo,
          attempts: 0,
          createdAt: thirteenHoursAgo,
        })
      );

      await t.mutation(internal.messageQueue.timeoutStaleSends, {});

      const message = await t.run(async (ctx) => ctx.db.get(messageId));
      expect(message?.status).toBe("failed");
      expect(message?.error).toContain("offline too long");
    });

    it("keeps stale pending messages queued when desktop sender is online", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { userId } = await setupAuthenticatedUser(t);
      const now = Date.now();

      const messageId = await t.run(async (ctx) => {
        await ctx.db.insert("devicePresence", {
          userId,
          deviceType: "electron",
          lastHeartbeatAt: now,
        });

        return ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Waiting with desktop online",
          isGroup: false,
          status: "pending",
          scheduledFor: now - 20_000,
          attempts: 0,
          createdAt: now - 20_000,
        });
      });

      await t.mutation(internal.messageQueue.timeoutStaleSends, {});

      const message = await t.run(async (ctx) => ctx.db.get(messageId));
      expect(message?.status).toBe("pending");
    });
  });

  // ============================================================================
  // OPTIMISTIC MESSAGE MERGE
  // ============================================================================

  describe("optimistic message merge in getMessages", () => {
    it("includes pending queue entries in conversation messages", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();

      const { conversationId } = await t.run(async (ctx) => {
        const contactId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId)
        );
        const conversationId = await ctx.db.insert(
          "conversations",
          createTestConversationData(userId, {
            participantContactIds: [contactId],
            lastMessageAt: now - 60000,
          })
        );
        // Existing real message
        await ctx.db.insert(
          "messages",
          createTestMessageData(userId, conversationId, {
            content: "Hey there",
            sentAt: now - 60000,
          })
        );
        // Queued message (pending)
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "My reply",
          isGroup: false,
          conversationId,
          status: "pending",
          scheduledFor: now + 25000,
          attempts: 0,
          createdAt: now,
        });
        return { conversationId };
      });

      const result = await asUser.query(api.messages.getMessages, {
        conversationId,
      });

      expect(result.messages).toHaveLength(2);
      const queuedMsg = result.messages.find((m) => m.content === "My reply");
      expect(queuedMsg).toBeTruthy();
      expect(queuedMsg?.isFromMe).toBe(true);
      expect(queuedMsg?.status).toBe("queued");
    });

    it("includes sending queue entries in conversation messages", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();

      const { conversationId } = await t.run(async (ctx) => {
        const conversationId = await ctx.db.insert(
          "conversations",
          createTestConversationData(userId, { lastMessageAt: now - 60000 })
        );
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Being sent now",
          isGroup: false,
          conversationId,
          status: "sending",
          scheduledFor: now - 1000,
          attempts: 1,
          createdAt: now - 31000,
        });
        return { conversationId };
      });

      const result = await asUser.query(api.messages.getMessages, {
        conversationId,
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe("Being sent now");
      expect(result.messages[0].status).toBe("sending");
    });

    it("includes failed queue entries in conversation messages", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();

      const { conversationId } = await t.run(async (ctx) => {
        const conversationId = await ctx.db.insert(
          "conversations",
          createTestConversationData(userId, { lastMessageAt: now - 60000 })
        );
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Failed to send",
          isGroup: false,
          conversationId,
          status: "failed",
          scheduledFor: now - 1000,
          attempts: 3,
          createdAt: now - 120000,
          error: "Network error",
        });
        return { conversationId };
      });

      const result = await asUser.query(api.messages.getMessages, {
        conversationId,
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe("Failed to send");
      expect(result.messages[0].status).toBe("failed");
    });

    it("keeps recent sent queue entries visible until sync writes the canonical message", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();

      const { conversationId } = await t.run(async (ctx) => {
        const conversationId = await ctx.db.insert(
          "conversations",
          createTestConversationData(userId, { lastMessageAt: now - 60000 })
        );
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Just sent but not synced yet",
          isGroup: false,
          conversationId,
          status: "sent",
          scheduledFor: now - 2000,
          attempts: 1,
          createdAt: now - 4000,
          sentAt: now - 2000,
        });
        return { conversationId };
      });

      const result = await asUser.query(api.messages.getMessages, {
        conversationId,
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe("Just sent but not synced yet");
      expect(result.messages[0].status).toBe("sent");
    });

    it("hides sent queue entries once a matching synced message exists", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();

      const { conversationId } = await t.run(async (ctx) => {
        const conversationId = await ctx.db.insert(
          "conversations",
          createTestConversationData(userId, { lastMessageAt: now })
        );

        await ctx.db.insert(
          "messages",
          createTestMessageData(userId, conversationId, {
            content: "Synced message",
            isFromMe: true,
            sentAt: now,
          })
        );

        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Synced message",
          isGroup: false,
          conversationId,
          status: "sent",
          scheduledFor: now - 3000,
          attempts: 1,
          createdAt: now - 5000,
          sentAt: now - 1000,
        });

        return { conversationId };
      });

      const result = await asUser.query(api.messages.getMessages, {
        conversationId,
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe("Synced message");
    });

    it("preserves message order across queue-to-synced handoff", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();

      const { conversationId } = await t.run(async (ctx) => {
        const conversationId = await ctx.db.insert(
          "conversations",
          createTestConversationData(userId, { lastMessageAt: now - 1000 })
        );

        await ctx.db.insert(
          "messages",
          createTestMessageData(userId, conversationId, {
            content: "Older message",
            isFromMe: false,
            sentAt: now - 4000,
          })
        );

        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Newer outgoing",
          isGroup: false,
          conversationId,
          status: "sent",
          scheduledFor: now - 2000,
          attempts: 1,
          createdAt: now - 3000,
          sentAt: now - 2000,
        });

        return { conversationId };
      });

      const beforeSync = await asUser.query(api.messages.getMessages, {
        conversationId,
      });
      expect(beforeSync.messages.map((m) => m.content)).toEqual([
        "Newer outgoing",
        "Older message",
      ]);

      await t.run(async (ctx) => {
        await ctx.db.insert(
          "messages",
          createTestMessageData(userId, conversationId, {
            content: "Newer outgoing",
            isFromMe: true,
            sentAt: now - 2000,
          })
        );
      });

      const afterSync = await asUser.query(api.messages.getMessages, {
        conversationId,
      });
      expect(afterSync.messages.map((m) => m.content)).toEqual([
        "Newer outgoing",
        "Older message",
      ]);
      expect(afterSync.messages).toHaveLength(2);
    });

    it("excludes cancelled queue entries from conversation messages", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();

      const { conversationId } = await t.run(async (ctx) => {
        const conversationId = await ctx.db.insert(
          "conversations",
          createTestConversationData(userId, { lastMessageAt: now - 60000 })
        );
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Cancelled message",
          isGroup: false,
          conversationId,
          status: "cancelled",
          scheduledFor: now + 25000,
          attempts: 0,
          createdAt: now,
          cancelledAt: now,
        });
        return { conversationId };
      });

      const result = await asUser.query(api.messages.getMessages, {
        conversationId,
      });

      expect(result.messages).toHaveLength(0);
    });

    it("excludes stale sent queue entries from conversation messages", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();

      const { conversationId } = await t.run(async (ctx) => {
        const conversationId = await ctx.db.insert(
          "conversations",
          createTestConversationData(userId, { lastMessageAt: now - 60000 })
        );
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Already sent",
          isGroup: false,
          conversationId,
          status: "sent",
          scheduledFor: now - 900000,
          attempts: 1,
          createdAt: now - 901000,
          sentAt: now - 900000,
        });
        return { conversationId };
      });

      const result = await asUser.query(api.messages.getMessages, {
        conversationId,
      });

      expect(result.messages).toHaveLength(0);
    });

    it("does not include queue entries without conversationId", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();

      const { conversationId } = await t.run(async (ctx) => {
        const conversationId = await ctx.db.insert(
          "conversations",
          createTestConversationData(userId, { lastMessageAt: now - 60000 })
        );
        // Queue entry without conversationId
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "No conversation",
          isGroup: false,
          status: "pending",
          scheduledFor: now + 25000,
          attempts: 0,
          createdAt: now,
        });
        return { conversationId };
      });

      const result = await asUser.query(api.messages.getMessages, {
        conversationId,
      });

      expect(result.messages).toHaveLength(0);
    });

    it("only merges queue entries on first page (no cursor)", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();

      const { conversationId } = await t.run(async (ctx) => {
        const conversationId = await ctx.db.insert(
          "conversations",
          createTestConversationData(userId, { lastMessageAt: now - 60000 })
        );
        // Real message
        await ctx.db.insert(
          "messages",
          createTestMessageData(userId, conversationId, {
            content: "Old message",
            sentAt: now - 60000,
          })
        );
        // Queued message
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Queued reply",
          isGroup: false,
          conversationId,
          status: "pending",
          scheduledFor: now + 25000,
          attempts: 0,
          createdAt: now,
        });
        return { conversationId };
      });

      // With cursor (paginated) - should NOT include queue entries
      const result = await asUser.query(api.messages.getMessages, {
        conversationId,
        cursor: String(now + 1),
      });

      const queuedMsg = result.messages.find(
        (m) => m.content === "Queued reply"
      );
      expect(queuedMsg).toBeUndefined();
    });
  });

  describe("optimistic inbox preview", () => {
    it("updates conversation preview when queue entry is newer", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();

      await t.run(async (ctx) => {
        const contactId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId)
        );
        const conversationId = await ctx.db.insert(
          "conversations",
          createTestConversationData(userId, {
            participantContactIds: [contactId],
            lastMessageText: "Their old message",
            lastMessageAt: now - 60000,
          })
        );
        // Queued message newer than last message
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "My queued reply",
          isGroup: false,
          conversationId,
          status: "pending",
          scheduledFor: now + 25000,
          attempts: 0,
          createdAt: now,
        });
      });

      const result = await asUser.query(api.messages.getInbox, {});

      expect(result.conversations).toHaveLength(1);
      expect(result.conversations[0].lastMessageText).toBe("My queued reply");
      expect(result.conversations[0].lastMessageAt).toBe(now);
    });

    it("bridges preview with recent sent queue entries before sync catches up", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();

      await t.run(async (ctx) => {
        const contactId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId)
        );
        const conversationId = await ctx.db.insert(
          "conversations",
          createTestConversationData(userId, {
            participantContactIds: [contactId],
            lastMessageText: "Old synced message",
            lastMessageAt: now - 60000,
          })
        );
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Recently sent optimistic message",
          isGroup: false,
          conversationId,
          status: "sent",
          scheduledFor: now - 2000,
          attempts: 1,
          createdAt: now - 4000,
          sentAt: now - 2000,
        });
      });

      const result = await asUser.query(api.messages.getInbox, {});

      expect(result.conversations).toHaveLength(1);
      expect(result.conversations[0].lastMessageText).toBe(
        "Recently sent optimistic message"
      );
      expect(result.conversations[0].lastMessageAt).toBe(now - 4000);
    });

    it("does not update preview when last message is newer than queue entry", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();

      await t.run(async (ctx) => {
        const contactId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId)
        );
        const conversationId = await ctx.db.insert(
          "conversations",
          createTestConversationData(userId, {
            participantContactIds: [contactId],
            lastMessageText: "Recent message",
            lastMessageAt: now,
          })
        );
        // Older queue entry
        await ctx.db.insert("messageQueue", {
          userId,
          platform: "imessage",
          recipientHandle: "+15551234567",
          text: "Old queued message",
          isGroup: false,
          conversationId,
          status: "sent",
          scheduledFor: now - 90000,
          attempts: 1,
          createdAt: now - 120000,
          sentAt: now - 90000,
        });
      });

      const result = await asUser.query(api.messages.getInbox, {});

      expect(result.conversations).toHaveLength(1);
      expect(result.conversations[0].lastMessageText).toBe("Recent message");
    });
  });
});
