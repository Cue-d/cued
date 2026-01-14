/**
 * Task 3.13b: Batch memory extraction from messages using Mem0.
 *
 * This module processes messages in batches to extract CRM-relevant memories
 * about contacts using the Mem0 API.
 */
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthenticatedUser } from "./lib/auth";
import { platformValidator } from "./schema";

// Rate limiting: ~100 messages per minute = ~1.67 msgs/sec
// Process in batches of 50, with delay between batches
const BATCH_SIZE = 50;
const MIN_MESSAGE_LENGTH = 10; // Skip very short messages

type Platform = "imessage" | "gmail" | "slack";

/**
 * Find integration by user and platform.
 */
function findIntegration(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  platform: Platform
): Promise<Doc<"integrations"> | null> {
  return ctx.db
    .query("integrations")
    .withIndex("by_user_platform", (q) =>
      q.eq("userId", userId).eq("platform", platform)
    )
    .unique();
}

/**
 * Build a map from IDs to documents, filtering out nulls.
 */
function buildDocMap<T extends Doc<"conversations"> | Doc<"contacts">>(
  docs: (T | null)[]
): Map<T["_id"], T> {
  return new Map(
    docs.filter((d): d is T => d !== null).map((d) => [d._id, d])
  );
}

/**
 * Get messages that need memory processing.
 * Returns messages older than lastMemoryProcessedAt cursor.
 */
export const getMessagesForMemoryProcessing = internalQuery({
  args: {
    userId: v.id("users"),
    cursor: v.optional(v.number()), // sentAt timestamp cursor
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const query = ctx.db
      .query("messages")
      .withIndex("by_user_sent_at", (q) => {
        const base = q.eq("userId", args.userId);
        return args.cursor ? base.gt("sentAt", args.cursor) : base;
      })
      .order("asc");

    const messages = await query.take(args.limit);
    if (messages.length === 0) return [];

    // Batch fetch conversations and contacts
    const conversationIds = [...new Set(messages.map((m) => m.conversationId))];
    const contactIds = [
      ...new Set(
        messages
          .map((m) => m.senderContactId)
          .filter((id): id is Id<"contacts"> => id !== undefined)
      ),
    ];

    const [conversations, contacts] = await Promise.all([
      Promise.all(conversationIds.map((id) => ctx.db.get(id))),
      Promise.all(contactIds.map((id) => ctx.db.get(id))),
    ]);

    const conversationMap = buildDocMap(conversations);
    const contactMap = buildDocMap(contacts);

    return messages.map((m) => {
      const conversation = conversationMap.get(m.conversationId);
      const senderContact = m.senderContactId
        ? contactMap.get(m.senderContactId)
        : undefined;

      // Determine primary contact: sender for received messages, DM participant otherwise
      const primaryContact = senderContact ?? (
        conversation?.conversationType === "dm"
          ? contactMap.get(conversation.participantContactIds[0])
          : undefined
      );

      return {
        _id: m._id,
        content: m.content,
        sentAt: m.sentAt,
        isFromMe: m.isFromMe,
        conversationId: m.conversationId,
        conversationType: conversation?.conversationType,
        primaryContactId: primaryContact?._id ?? conversation?.participantContactIds[0],
        primaryContactName: primaryContact?.displayName,
      };
    });
  },
});

/**
 * Update memory processing state after a batch is processed.
 */
export const updateMemoryProcessingState = internalMutation({
  args: {
    userId: v.id("users"),
    platform: platformValidator,
    lastProcessedAt: v.number(),
    messagesProcessed: v.number(),
    memoriesExtracted: v.number(),
  },
  handler: async (ctx, args) => {
    const integration = await findIntegration(ctx, args.userId, args.platform);
    if (!integration) {
      throw new Error(`No integration found for user ${args.userId} platform ${args.platform}`);
    }

    const { syncState } = integration;
    await ctx.db.patch(integration._id, {
      syncState: {
        ...syncState,
        lastMemoryProcessedAt: args.lastProcessedAt,
        totalMessagesProcessedForMemory: (syncState.totalMessagesProcessedForMemory ?? 0) + args.messagesProcessed,
        totalMemoriesExtracted: (syncState.totalMemoriesExtracted ?? 0) + args.memoriesExtracted,
      },
    });
  },
});

/**
 * Get memory processing status for a user.
 */
export const getMemoryProcessingStatus = query({
  args: {
    platform: platformValidator,
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return null;

    const integration = await findIntegration(ctx, user._id, args.platform);
    if (!integration) return null;

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    const { syncState } = integration;
    return {
      lastProcessedAt: syncState.lastMemoryProcessedAt ?? null,
      totalMessagesProcessed: syncState.totalMessagesProcessedForMemory ?? 0,
      totalMemoriesExtracted: syncState.totalMemoriesExtracted ?? 0,
      totalMessages: messages.length,
    };
  },
});

interface MemoryExtractionResult {
  messagesProcessed: number;
  memoriesExtracted: number;
  lastProcessedAt: number | null;
  errors: string[];
}

/**
 * Process a batch of messages to extract memories using Mem0.
 * This is a Convex action because it calls external APIs.
 */
export const processMemoryBatch = action({
  args: {
    platform: platformValidator,
  },
  handler: async (ctx, args): Promise<MemoryExtractionResult> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated");
    }

    // Get user
    const user = await ctx.runQuery(internal.memories.getUserByWorkosId, {
      workosUserId: identity.subject,
    });
    if (!user) {
      throw new Error("User not found");
    }

    // Get current memory processing cursor
    const integration = await ctx.runQuery(internal.memories.getIntegration, {
      userId: user._id,
      platform: args.platform,
    });
    const cursor = integration?.syncState.lastMemoryProcessedAt ?? undefined;

    // Get messages to process
    const messages = await ctx.runQuery(
      internal.memories.getMessagesForMemoryProcessing,
      {
        userId: user._id,
        cursor,
        limit: BATCH_SIZE,
      }
    );

    if (messages.length === 0) {
      return {
        messagesProcessed: 0,
        memoriesExtracted: 0,
        lastProcessedAt: cursor ?? null,
        errors: [],
      };
    }

    // Group messages by contact for memory extraction
    type MessageGroup = { contactId: Id<"contacts">; contactName: string; messages: typeof messages };
    const messagesByContact = new Map<string, MessageGroup>();

    for (const msg of messages) {
      if (!msg.primaryContactId || !msg.primaryContactName) continue;
      if (msg.content.length < MIN_MESSAGE_LENGTH) continue;

      const existing = messagesByContact.get(msg.primaryContactId);
      if (existing) {
        existing.messages.push(msg);
      } else {
        messagesByContact.set(msg.primaryContactId, {
          contactId: msg.primaryContactId,
          contactName: msg.primaryContactName,
          messages: [msg],
        });
      }
    }

    // Extract memories for each contact
    const result: MemoryExtractionResult = {
      messagesProcessed: messages.length,
      memoriesExtracted: 0,
      lastProcessedAt: messages[messages.length - 1].sentAt,
      errors: [],
    };

    for (const group of messagesByContact.values()) {
      try {
        const memResult = await extractMemoriesForContact(
          user._id.toString(),
          group.contactId,
          group.contactName,
          group.messages
        );
        result.memoriesExtracted += memResult.memoriesAdded + memResult.memoriesUpdated;
      } catch (e) {
        result.errors.push(`Failed to extract memories for ${group.contactName}: ${e}`);
      }
    }

    // Update processing state
    await ctx.runMutation(internal.memories.updateMemoryProcessingState, {
      userId: user._id,
      platform: args.platform,
      lastProcessedAt: result.lastProcessedAt!,
      messagesProcessed: result.messagesProcessed,
      memoriesExtracted: result.memoriesExtracted,
    });

    return result;
  },
});

/**
 * Internal helper to get user by WorkOS ID.
 */
export const getUserByWorkosId = internalQuery({
  args: { workosUserId: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("users")
      .withIndex("by_workos_id", (q) => q.eq("workosUserId", args.workosUserId))
      .unique();
  },
});

/**
 * Internal helper to get integration.
 */
export const getIntegration = internalQuery({
  args: {
    userId: v.id("users"),
    platform: platformValidator,
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("integrations")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", args.userId).eq("platform", args.platform)
      )
      .unique();
  },
});

/**
 * Extract memories from messages for a specific contact using Mem0.
 */
async function extractMemoriesForContact(
  userId: string,
  contactId: Id<"contacts">,
  contactName: string,
  messages: Array<{ content: string; isFromMe: boolean }>
): Promise<{ memoriesAdded: number; memoriesUpdated: number; memoriesDeleted: number }> {
  const conversationMessages = messages.map((m) => ({
    role: m.isFromMe ? ("user" as const) : ("assistant" as const),
    content: m.content,
  }));

  const { addContactMemories } = await import("@prm/ai");
  return addContactMemories(conversationMessages, userId, contactId, contactName);
}

/**
 * Reset memory processing state to reprocess all messages.
 */
export const resetMemoryProcessingState = internalMutation({
  args: {
    userId: v.id("users"),
    platform: platformValidator,
  },
  handler: async (ctx, args) => {
    const integration = await findIntegration(ctx, args.userId, args.platform);
    if (!integration) return;

    await ctx.db.patch(integration._id, {
      syncState: {
        ...integration.syncState,
        lastMemoryProcessedAt: undefined,
        totalMessagesProcessedForMemory: 0,
        totalMemoriesExtracted: 0,
      },
    });
  },
});
