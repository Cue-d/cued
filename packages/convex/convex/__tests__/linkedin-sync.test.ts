/**
 * Tests for LinkedIn sync functions.
 * Tests conversation sync, message sync, deduplication, and contact creation.
 *
 * Note: InMail filtering tests are in linkedin-filters.test.ts
 */

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../schema";
import { modules } from "./test.setup";
import { createTestUserData, createTestIdentity } from "./helpers";
import { useSchedulerCleanup } from "./schedulerCleanup";
import { api } from "../_generated/api";

const { trackTest } = useSchedulerCleanup();

/**
 * Helper to set up an authenticated test environment.
 */
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

/**
 * Create a test LinkedIn participant
 */
function createParticipant(
  overrides: Partial<{
    entityURN: string;
    firstName: string;
    lastName: string;
    profileUrl: string;
    headline: string;
  }> = {}
) {
  return {
    entityURN: overrides.entityURN ?? `urn:li:fs_miniProfile:${Date.now()}`,
    firstName: overrides.firstName ?? "Test",
    lastName: overrides.lastName ?? "User",
    profileUrl:
      overrides.profileUrl ??
      `https://www.linkedin.com/in/testuser-${Date.now()}`,
    headline: overrides.headline ?? "Software Engineer",
  };
}

/**
 * Create a test LinkedIn conversation
 */
function createConversation(
  overrides: Partial<{
    entityURN: string;
    title: string;
    lastActivityAt: number;
    lastReadAt: number;
    groupChat: boolean;
    read: boolean;
    categories: string[];
    unreadCount: number;
    participants: ReturnType<typeof createParticipant>[];
  }> = {}
) {
  return {
    entityURN: overrides.entityURN ?? `urn:li:fs_conversation:${Date.now()}`,
    title: overrides.title ?? "Test Conversation",
    lastActivityAt: overrides.lastActivityAt ?? Date.now(),
    lastReadAt: overrides.lastReadAt ?? Date.now(),
    groupChat: overrides.groupChat ?? false,
    read: overrides.read ?? true,
    categories: overrides.categories ?? [],
    unreadCount: overrides.unreadCount ?? 0,
    participants: overrides.participants ?? [createParticipant()],
  };
}

/**
 * Create a test LinkedIn message
 */
function createMessage(
  conversationURN: string,
  overrides: Partial<{
    entityURN: string;
    text: string;
    deliveredAt: number;
    senderURN: string;
    senderProfileUrl: string;
    senderFirstName: string;
    senderLastName: string;
    messageBodyRenderFormat: "DEFAULT" | "EDITED" | "RECALLED" | "SYSTEM";
  }> = {}
) {
  return {
    entityURN: overrides.entityURN ?? `urn:li:fs_message:${Date.now()}`,
    conversationURN,
    text: overrides.text ?? "Test message",
    deliveredAt: overrides.deliveredAt ?? Date.now(),
    senderURN: overrides.senderURN ?? `urn:li:fs_miniProfile:sender-${Date.now()}`,
    senderProfileUrl: overrides.senderProfileUrl,
    senderFirstName: overrides.senderFirstName ?? "Sender",
    senderLastName: overrides.senderLastName ?? "Name",
    messageBodyRenderFormat: overrides.messageBodyRenderFormat ?? "DEFAULT",
  };
}

describe("LinkedIn Sync", () => {
  // ============================================================================
  // syncLinkedInConversations Tests
  // ============================================================================
  describe("syncLinkedInConversations", () => {
    it("throws for unauthenticated user", async () => {
      const t = trackTest(convexTest(schema, modules));

      await expect(
        t.mutation(api.sync.syncLinkedInConversations, {
          conversations: [],
        })
      ).rejects.toThrow("Unauthorized");
    });

    it("creates new conversation and links participant", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { userId, asUser } = await setupAuthenticatedUser(t);

      const participant = createParticipant({
        firstName: "Alice",
        lastName: "Smith",
        profileUrl: "https://www.linkedin.com/in/alice-smith",
      });

      const result = await asUser.mutation(api.sync.syncLinkedInConversations, {
        conversations: [
          createConversation({
            entityURN: "urn:li:fs_conversation:123",
            title: "Alice Smith",
            participants: [participant],
          }),
        ],
      });

      expect(result.conversationsCount).toBe(1);
      expect(result.newConversations).toBe(1);
      expect(result.participantsLinked).toBe(1);

      // Verify conversation was created
      const conversations = await t.run(async (ctx) => {
        return ctx.db
          .query("conversations")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(conversations).toHaveLength(1);
      expect(conversations[0].platform).toBe("linkedin");
      expect(conversations[0].platformConversationId).toBe(
        "urn:li:fs_conversation:123"
      );
      expect(conversations[0].displayName).toBe("Alice Smith");
      expect(conversations[0].conversationType).toBe("dm");

      // Verify contact was created
      const contacts = await t.run(async (ctx) => {
        return ctx.db
          .query("contacts")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(contacts).toHaveLength(1);
      expect(contacts[0].displayName).toBe("Alice Smith");
    });

    it("updates existing conversation", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { userId, asUser } = await setupAuthenticatedUser(t);

      // Create existing conversation
      const existingId = await t.run(async (ctx) => {
        return ctx.db.insert("conversations", {
          userId,
          platform: "linkedin",
          platformConversationId: "urn:li:fs_conversation:123",
          conversationType: "dm",
          participantContactIds: [],
          unreadCount: 5,
          displayName: "Old Name",
          lastMessageAt: 1000,
        });
      });

      const participant = createParticipant({
        firstName: "Alice",
        lastName: "Smith",
      });

      const result = await asUser.mutation(api.sync.syncLinkedInConversations, {
        conversations: [
          createConversation({
            entityURN: "urn:li:fs_conversation:123",
            title: "Alice Smith",
            unreadCount: 2,
            lastActivityAt: 5000,
            participants: [participant],
          }),
        ],
      });

      expect(result.updatedConversations).toBe(1);

      // Verify conversation was updated
      const conversation = await t.run(async (ctx) => {
        return ctx.db.get(existingId);
      });

      expect(conversation?.displayName).toBe("Alice Smith");
      expect(conversation?.unreadCount).toBe(2);
      // Note: lastMessageAt is NOT updated by conversation sync (only by message sync)
      // This is intentional - see comment in syncLinkedInConversationsInternal
      expect(conversation?.lastMessageAt).toBe(1000);
    });

    it("creates group conversation for groupChat=true", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { userId, asUser } = await setupAuthenticatedUser(t);

      const result = await asUser.mutation(api.sync.syncLinkedInConversations, {
        conversations: [
          createConversation({
            entityURN: "urn:li:fs_conversation:group1",
            title: "Team Chat",
            groupChat: true,
            participants: [
              createParticipant({ firstName: "Alice" }),
              createParticipant({ firstName: "Bob" }),
            ],
          }),
        ],
      });

      expect(result.conversationsCount).toBe(1);
      expect(result.participantsLinked).toBe(2);

      const conversation = await t.run(async (ctx) => {
        return ctx.db
          .query("conversations")
          .withIndex("by_platform_conversation", (q) =>
            q
              .eq("userId", userId)
              .eq("platform", "linkedin")
              .eq("platformConversationId", "urn:li:fs_conversation:group1")
          )
          .unique();
      });

      expect(conversation?.conversationType).toBe("group");
      expect(conversation?.participantContactIds).toHaveLength(2);
    });

    it("deduplicates contacts by profile URL", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { userId, asUser } = await setupAuthenticatedUser(t);

      const profileUrl = "https://www.linkedin.com/in/alice-smith";

      // Sync two conversations with same participant
      await asUser.mutation(api.sync.syncLinkedInConversations, {
        conversations: [
          createConversation({
            entityURN: "urn:li:fs_conversation:1",
            participants: [createParticipant({ profileUrl })],
          }),
          createConversation({
            entityURN: "urn:li:fs_conversation:2",
            participants: [createParticipant({ profileUrl })],
          }),
        ],
      });

      // Should only create one contact (deduplicated)
      const contacts = await t.run(async (ctx) => {
        return ctx.db
          .query("contacts")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(contacts).toHaveLength(1);
    });
  });

  // ============================================================================
  // syncLinkedInMessages Tests
  // ============================================================================
  describe("syncLinkedInMessages", () => {
    it("throws for unauthenticated user", async () => {
      const t = trackTest(convexTest(schema, modules));

      await expect(
        t.mutation(api.sync.syncLinkedInMessages, {
          messages: [],
        })
      ).rejects.toThrow("Unauthorized");
    });

    it("creates message and sender contact", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { userId, asUser } = await setupAuthenticatedUser(t);

      const conversationURN = "urn:li:fs_conversation:123";

      const result = await asUser.mutation(api.sync.syncLinkedInMessages, {
        messages: [
          createMessage(conversationURN, {
            entityURN: "urn:li:fs_message:msg1",
            text: "Hello there!",
            senderFirstName: "Alice",
            senderLastName: "Smith",
            senderProfileUrl: "https://www.linkedin.com/in/alice-smith",
          }),
        ],
      });

      expect(result.messagesCount).toBe(1);
      expect(result.newMessages).toBe(1);

      // Verify message was created
      const messages = await t.run(async (ctx) => {
        return ctx.db
          .query("messages")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Hello there!");
      expect(messages[0].platform).toBe("linkedin");
      expect(messages[0].isFromMe).toBe(false);

      // Verify contact was created for sender
      const contacts = await t.run(async (ctx) => {
        return ctx.db
          .query("contacts")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(contacts).toHaveLength(1);
      expect(contacts[0].displayName).toBe("Alice Smith");
    });

    it("detects isFromMe using linkedInUserURN", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { userId, asUser } = await setupAuthenticatedUser(t);

      const userURN = "urn:li:fs_miniProfile:myprofile";
      const conversationURN = "urn:li:fs_conversation:123";

      // Create integration with linkedInUserURN
      await t.run(async (ctx) => {
        await ctx.db.insert("integrations", {
          userId,
          platform: "linkedin",
          connectedAt: Date.now(),
          linkedInUserURN: userURN,
          isConnected: true,
        });
      });

      const result = await asUser.mutation(api.sync.syncLinkedInMessages, {
        messages: [
          // Message from user
          createMessage(conversationURN, {
            entityURN: "urn:li:fs_message:my-msg",
            text: "My message",
            senderURN: userURN,
            senderFirstName: "Me",
            senderLastName: "Myself",
          }),
          // Message from other
          createMessage(conversationURN, {
            entityURN: "urn:li:fs_message:other-msg",
            text: "Their message",
            senderURN: "urn:li:fs_miniProfile:other",
            senderFirstName: "Other",
            senderLastName: "Person",
          }),
        ],
      });

      expect(result.messagesCount).toBe(2);

      const messages = await t.run(async (ctx) => {
        return ctx.db
          .query("messages")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      const myMsg = messages.find((m) => m.content === "My message");
      const theirMsg = messages.find((m) => m.content === "Their message");

      expect(myMsg?.isFromMe).toBe(true);
      expect(myMsg?.senderContactId).toBeUndefined();

      expect(theirMsg?.isFromMe).toBe(false);
      expect(theirMsg?.senderContactId).toBeDefined();
    });

    it("detects isFromMe with different URN prefixes (fsd_profile vs fs_miniProfile)", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { userId, asUser } = await setupAuthenticatedUser(t);

      // User URN stored as fsd_profile (from /me endpoint)
      const userURN = "urn:li:fsd_profile:ABC123";
      const conversationURN = "urn:li:fs_conversation:456";

      // Create integration with fsd_profile URN format
      await t.run(async (ctx) => {
        await ctx.db.insert("integrations", {
          userId,
          platform: "linkedin",
          connectedAt: Date.now(),
          linkedInUserURN: userURN,
          isConnected: true,
        });
      });

      const result = await asUser.mutation(api.sync.syncLinkedInMessages, {
        messages: [
          // Message from user - sender URN uses fs_miniProfile prefix (from messaging API)
          createMessage(conversationURN, {
            entityURN: "urn:li:fs_message:my-msg",
            text: "My message with different URN prefix",
            senderURN: "urn:li:fs_miniProfile:ABC123", // Same ID, different prefix
            senderFirstName: "Me",
            senderLastName: "Myself",
          }),
          // Message from other
          createMessage(conversationURN, {
            entityURN: "urn:li:fs_message:other-msg",
            text: "Their message",
            senderURN: "urn:li:fs_miniProfile:XYZ789",
            senderFirstName: "Other",
            senderLastName: "Person",
          }),
        ],
      });

      expect(result.messagesCount).toBe(2);

      const messages = await t.run(async (ctx) => {
        return ctx.db
          .query("messages")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      const myMsg = messages.find((m) => m.content === "My message with different URN prefix");
      const theirMsg = messages.find((m) => m.content === "Their message");

      // Should correctly identify message as from user despite different URN prefix
      expect(myMsg?.isFromMe).toBe(true);
      expect(myMsg?.senderContactId).toBeUndefined();

      expect(theirMsg?.isFromMe).toBe(false);
      expect(theirMsg?.senderContactId).toBeDefined();
    });

    it("deduplicates messages by entityURN", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { userId, asUser } = await setupAuthenticatedUser(t);

      const conversationURN = "urn:li:fs_conversation:123";
      const messageURN = "urn:li:fs_message:dup";

      // First sync
      await asUser.mutation(api.sync.syncLinkedInMessages, {
        messages: [
          createMessage(conversationURN, {
            entityURN: messageURN,
            text: "Original",
          }),
        ],
      });

      // Second sync with same message
      const result = await asUser.mutation(api.sync.syncLinkedInMessages, {
        messages: [
          createMessage(conversationURN, {
            entityURN: messageURN,
            text: "Should be skipped",
          }),
        ],
      });

      expect(result.skippedMessages).toBe(1);
      expect(result.newMessages).toBe(0);

      // Should only have one message
      const messages = await t.run(async (ctx) => {
        return ctx.db
          .query("messages")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Original");
    });

    it("skips RECALLED and SYSTEM messages", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser } = await setupAuthenticatedUser(t);

      const conversationURN = "urn:li:fs_conversation:123";

      const result = await asUser.mutation(api.sync.syncLinkedInMessages, {
        messages: [
          createMessage(conversationURN, {
            entityURN: "urn:li:fs_message:recalled",
            text: "Recalled message",
            messageBodyRenderFormat: "RECALLED",
          }),
          createMessage(conversationURN, {
            entityURN: "urn:li:fs_message:system",
            text: "System message",
            messageBodyRenderFormat: "SYSTEM",
          }),
          createMessage(conversationURN, {
            entityURN: "urn:li:fs_message:normal",
            text: "Normal message",
            messageBodyRenderFormat: "DEFAULT",
          }),
        ],
      });

      expect(result.skippedMessages).toBe(2);
      expect(result.newMessages).toBe(1);
    });

    it("creates conversation if it doesn't exist", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { userId, asUser } = await setupAuthenticatedUser(t);

      const conversationURN = "urn:li:fs_conversation:new";

      await asUser.mutation(api.sync.syncLinkedInMessages, {
        messages: [
          createMessage(conversationURN, {
            text: "Message in new conversation",
          }),
        ],
      });

      // Verify conversation was auto-created
      const conversation = await t.run(async (ctx) => {
        return ctx.db
          .query("conversations")
          .withIndex("by_platform_conversation", (q) =>
            q
              .eq("userId", userId)
              .eq("platform", "linkedin")
              .eq("platformConversationId", conversationURN)
          )
          .unique();
      });

      expect(conversation).not.toBeNull();
      expect(conversation?.conversationType).toBe("dm"); // Default
    });

    it("updates conversation lastMessage", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { userId, asUser } = await setupAuthenticatedUser(t);

      const conversationURN = "urn:li:fs_conversation:123";

      // Create conversation
      await t.run(async (ctx) => {
        await ctx.db.insert("conversations", {
          userId,
          platform: "linkedin",
          platformConversationId: conversationURN,
          conversationType: "dm",
          participantContactIds: [],
          unreadCount: 0,
        });
      });

      await asUser.mutation(api.sync.syncLinkedInMessages, {
        messages: [
          createMessage(conversationURN, {
            text: "Latest message",
            deliveredAt: 5000,
          }),
        ],
      });

      const conversation = await t.run(async (ctx) => {
        return ctx.db
          .query("conversations")
          .withIndex("by_platform_conversation", (q) =>
            q
              .eq("userId", userId)
              .eq("platform", "linkedin")
              .eq("platformConversationId", conversationURN)
          )
          .unique();
      });

      expect(conversation?.lastMessageText).toBe("Latest message");
      expect(conversation?.lastMessageAt).toBe(5000);
    });
  });

  // ============================================================================
  // Contact URL Normalization Tests
  // ============================================================================
  describe("LinkedIn URL normalization", () => {
    it("normalizes profile URLs with query params", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { userId, asUser } = await setupAuthenticatedUser(t);

      const testURN = "urn:li:fs_miniProfile:test123";

      // Sync with URL containing query params
      await asUser.mutation(api.sync.syncLinkedInConversations, {
        conversations: [
          createConversation({
            participants: [
              createParticipant({
                entityURN: testURN,
                profileUrl:
                  "https://www.linkedin.com/in/alice-smith?lipi=xxx&licu=yyy",
              }),
            ],
          }),
        ],
      });

      const handles = await t.run(async (ctx) => {
        return ctx.db
          .query("contactHandles")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      // Now creates both URN handle (for deduplication) and slug handle (for display)
      // URN is normalized to urn:li:member:{id} format
      expect(handles).toHaveLength(2);
      const urnHandle = handles.find((h) => h.handleType === "linkedin_urn");
      const slugHandle = handles.find((h) => h.handleType === "linkedin_handle");
      expect(urnHandle?.handle).toBe("urn:li:member:test123"); // Normalized from fs_miniProfile
      expect(slugHandle?.handle).toBe("alice-smith");
    });

    it("normalizes different LinkedIn URL formats", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { userId, asUser } = await setupAuthenticatedUser(t);

      // Sync with different URL formats pointing to same profile
      await asUser.mutation(api.sync.syncLinkedInConversations, {
        conversations: [
          createConversation({
            entityURN: "conv1",
            participants: [
              createParticipant({
                profileUrl: "https://linkedin.com/in/Alice-Smith/",
              }),
            ],
          }),
          createConversation({
            entityURN: "conv2",
            participants: [
              createParticipant({
                profileUrl: "https://www.linkedin.com/in/alice-smith",
              }),
            ],
          }),
        ],
      });

      // Should only create one contact due to normalization
      const contacts = await t.run(async (ctx) => {
        return ctx.db
          .query("contacts")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(contacts).toHaveLength(1);
    });
  });
});
