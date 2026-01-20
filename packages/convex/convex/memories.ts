/**
 * Task 3.13b: Batch memory extraction from messages using Mem0.
 *
 * This module processes messages in batches to extract CRM-relevant memories
 * about contacts using the Mem0 API.
 */
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthenticatedUser } from "./lib/auth";
import { platformValidator } from "./schema";

// Rate limiting: ~100 messages per minute = ~1.67 msgs/sec
// Process in batches of 50, with delay between batches
const BATCH_SIZE = 50;
const MIN_MESSAGE_LENGTH = 10; // Skip very short messages

type Platform = "imessage" | "gmail" | "slack" | "linkedin" | "twitter" | "signal" | "whatsapp";

/** Message data enriched with contact/conversation context. */
interface EnrichedMessage {
  _id: Id<"messages">;
  content: string;
  sentAt: number;
  isFromMe: boolean;
  conversationId: Id<"conversations">;
  conversationType: "dm" | "group" | "channel" | undefined;
  primaryContactId: Id<"contacts"> | undefined;
  primaryContactName: string | undefined;
}

/** Group of messages for a single contact. */
interface MessageGroup {
  contactId: Id<"contacts">;
  contactName: string;
  messages: EnrichedMessage[];
  messageIds: Id<"messages">[];
}

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
  return new Map(docs.filter((d): d is T => d !== null).map((d) => [d._id, d]));
}

/**
 * Enrich messages with conversation and contact data.
 * Extracts the primary contact for memory extraction.
 */
async function enrichMessagesWithContext(
  ctx: QueryCtx,
  messages: Doc<"messages">[]
): Promise<EnrichedMessage[]> {
  if (messages.length === 0) return [];

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

    // Primary contact: sender for received messages, DM participant otherwise
    const primaryContact =
      senderContact ??
      (conversation?.conversationType === "dm"
        ? contactMap.get(conversation.participantContactIds[0])
        : undefined);

    return {
      _id: m._id,
      content: m.content,
      sentAt: m.sentAt,
      isFromMe: m.isFromMe,
      conversationId: m.conversationId,
      conversationType: conversation?.conversationType,
      primaryContactId:
        primaryContact?._id ?? conversation?.participantContactIds[0],
      primaryContactName: primaryContact?.displayName,
    };
  });
}

/**
 * Group messages by contact for batch memory extraction.
 * Filters out messages that are too short.
 */
function groupMessagesByContact(
  messages: EnrichedMessage[]
): Map<string, MessageGroup> {
  const groups = new Map<string, MessageGroup>();

  for (const msg of messages) {
    if (!msg.primaryContactId || !msg.primaryContactName) continue;
    if (msg.content.length < MIN_MESSAGE_LENGTH) continue;

    const existing = groups.get(msg.primaryContactId);
    if (existing) {
      existing.messages.push(msg);
      existing.messageIds.push(msg._id);
    } else {
      groups.set(msg.primaryContactId, {
        contactId: msg.primaryContactId,
        contactName: msg.primaryContactName,
        messages: [msg],
        messageIds: [msg._id],
      });
    }
  }

  return groups;
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
    return enrichMessagesWithContext(ctx, messages);
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
      throw new Error(
        `No integration found for user ${args.userId} platform ${args.platform}`
      );
    }

    const { syncState } = integration;
    await ctx.db.patch(integration._id, {
      syncState: {
        ...syncState,
        lastMemoryProcessedAt: args.lastProcessedAt,
        totalMessagesProcessedForMemory:
          (syncState.totalMessagesProcessedForMemory ?? 0) +
          args.messagesProcessed,
        totalMemoriesExtracted:
          (syncState.totalMemoriesExtracted ?? 0) + args.memoriesExtracted,
      },
    });
  },
});

/**
 * Upsert per-contact memory stats (denormalized for efficient queries).
 */
export const upsertContactMemoryStats = internalMutation({
  args: {
    userId: v.id("users"),
    contactId: v.id("contacts"),
    messagesProcessed: v.number(),
    memoriesExtracted: v.number(),
  },
  handler: async (ctx, args) => {
    // Get contact for denormalized fields
    const contact = await ctx.db.get(args.contactId);
    if (!contact) return;

    // Find existing stats
    const existing = await ctx.db
      .query("contactMemoryStats")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .unique();

    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        displayName: contact.displayName,
        company: contact.company,
        messagesProcessed: existing.messagesProcessed + args.messagesProcessed,
        memoriesExtracted: existing.memoriesExtracted + args.memoriesExtracted,
        lastExtractedAt: now,
      });
    } else {
      await ctx.db.insert("contactMemoryStats", {
        userId: args.userId,
        contactId: args.contactId,
        displayName: contact.displayName,
        company: contact.company,
        messagesProcessed: args.messagesProcessed,
        memoriesExtracted: args.memoriesExtracted,
        lastExtractedAt: now,
      });
    }
  },
});

/**
 * Get memory processing status for a user.
 * Returns stats from integration syncState (no expensive message collection).
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

    const { syncState } = integration;
    return {
      lastProcessedAt: syncState.lastMemoryProcessedAt ?? null,
      totalMessagesProcessed: syncState.totalMessagesProcessedForMemory ?? 0,
      totalMemoriesExtracted: syncState.totalMemoriesExtracted ?? 0,
      // Use totalMessagesSynced from syncState instead of expensive count
      totalMessages: syncState.totalMessagesSynced ?? 0,
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

    const messagesByContact = groupMessagesByContact(messages);

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
        const memoriesForContact =
          memResult.memoriesAdded + memResult.memoriesUpdated;
        result.memoriesExtracted += memoriesForContact;

        // Update per-contact stats
        await ctx.runMutation(internal.memories.upsertContactMemoryStats, {
          userId: user._id,
          contactId: group.contactId,
          messagesProcessed: group.messages.length,
          memoriesExtracted: memoriesForContact,
        });
      } catch (e) {
        result.errors.push(
          `Failed to extract memories for ${group.contactName}: ${e}`
        );
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
): Promise<{
  memoriesAdded: number;
  memoriesUpdated: number;
  memoriesDeleted: number;
}> {
  const conversationMessages = messages.map((m) => ({
    role: m.isFromMe ? ("user" as const) : ("assistant" as const),
    content: m.content,
  }));

  const { addContactMemories } = await import("@prm/ai");
  return addContactMemories(
    conversationMessages,
    userId,
    contactId,
    contactName
  );
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

// ============================================================================
// Task 3.13c: Automatic memory extraction on sync
// ============================================================================

// Rate limiting constants for incremental processing
const INCREMENTAL_BATCH_SIZE = 25; // Smaller batches for real-time processing
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000; // 1 second base delay for exponential backoff

/**
 * Get messages that haven't had memories extracted yet.
 * Task 3.13c: Uses memoryExtractedAt field for per-message deduplication.
 */
export const getUnprocessedMessages = internalQuery({
  args: {
    userId: v.id("users"),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    // Fetch extra messages and filter since Convex doesn't support filtering on undefined
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_user_sent_at", (q) => q.eq("userId", args.userId))
      .order("desc") // Process recent messages first
      .take(args.limit * 2);

    const unprocessed = messages
      .filter((m) => m.memoryExtractedAt === undefined)
      .slice(0, args.limit);

    return enrichMessagesWithContext(ctx, unprocessed);
  },
});

/**
 * Mark messages as having had memories extracted.
 * Task 3.13c: Sets memoryExtractedAt timestamp on processed messages.
 */
export const markMessagesAsProcessed = internalMutation({
  args: {
    messageIds: v.array(v.id("messages")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const messageId of args.messageIds) {
      await ctx.db.patch(messageId, { memoryExtractedAt: now });
    }
  },
});

interface IncrementalMemoryResult {
  messagesProcessed: number;
  memoriesExtracted: number;
  errors: string[];
  hasMore: boolean;
}

/**
 * Process new messages for memory extraction.
 * Task 3.13c: Called after sync to process newly synced messages.
 * Uses per-message tracking via memoryExtractedAt field.
 */
export const processNewMessagesForMemory = action({
  args: {
    platform: platformValidator,
  },
  handler: async (ctx, args): Promise<IncrementalMemoryResult> => {
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

    // Get unprocessed messages
    const messages = await ctx.runQuery(
      internal.memories.getUnprocessedMessages,
      {
        userId: user._id,
        limit: INCREMENTAL_BATCH_SIZE,
      }
    );

    if (messages.length === 0) {
      return {
        messagesProcessed: 0,
        memoriesExtracted: 0,
        errors: [],
        hasMore: false,
      };
    }

    const messagesByContact = groupMessagesByContact(messages);

    const result: IncrementalMemoryResult = {
      messagesProcessed: messages.length,
      memoriesExtracted: 0,
      errors: [],
      hasMore: messages.length >= INCREMENTAL_BATCH_SIZE,
    };

    for (const group of messagesByContact.values()) {
      let lastError: Error | null = null;
      let memoriesForContact = 0;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const memResult = await extractMemoriesForContact(
            user._id.toString(),
            group.contactId,
            group.contactName,
            group.messages
          );
          memoriesForContact =
            memResult.memoriesAdded + memResult.memoriesUpdated;
          result.memoriesExtracted += memoriesForContact;
          lastError = null;
          break;
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          const isRateLimit =
            lastError.message.includes("429") ||
            lastError.message.toLowerCase().includes("rate limit");

          if (isRateLimit && attempt < MAX_RETRIES - 1) {
            const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          } else if (!isRateLimit) {
            break;
          }
        }
      }

      if (lastError) {
        result.errors.push(
          `Failed to extract memories for ${group.contactName}: ${lastError.message}`
        );
      } else {
        // Update per-contact stats on success
        await ctx.runMutation(internal.memories.upsertContactMemoryStats, {
          userId: user._id,
          contactId: group.contactId,
          messagesProcessed: group.messages.length,
          memoriesExtracted: memoriesForContact,
        });
      }
    }

    // Mark all processed messages (including skipped short ones)
    const allMessageIds = messages.map((m: EnrichedMessage) => m._id);
    await ctx.runMutation(internal.memories.markMessagesAsProcessed, {
      messageIds: allMessageIds,
    });

    // Update integration stats
    const integration = await ctx.runQuery(internal.memories.getIntegration, {
      userId: user._id,
      platform: args.platform,
    });

    if (integration) {
      await ctx.runMutation(internal.memories.updateMemoryProcessingState, {
        userId: user._id,
        platform: args.platform,
        lastProcessedAt: Date.now(),
        messagesProcessed: result.messagesProcessed,
        memoriesExtracted: result.memoriesExtracted,
      });
    }

    return result;
  },
});

/**
 * Get count of unprocessed messages for memory extraction.
 * Useful for checking if there are messages waiting to be processed.
 */
export const getUnprocessedMessageCount = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return null;

    // Fetch recent messages and filter since Convex doesn't support filtering on undefined
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(1000);

    const unprocessedCount = messages.filter(
      (m) => m.memoryExtractedAt === undefined
    ).length;

    return {
      unprocessedCount,
      totalChecked: messages.length,
      hasMore: messages.length >= 1000,
    };
  },
});

/**
 * Get memory extraction stats grouped by contact.
 * Queries denormalized contactMemoryStats table (no expensive message scans).
 */
export const getMemoryStatsByContact = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return null;

    // Query denormalized stats table, sorted by most recent extraction
    const stats = await ctx.db
      .query("contactMemoryStats")
      .withIndex("by_user_recent", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(50);

    return stats.map((stat) => ({
      contactId: stat.contactId,
      displayName: stat.displayName,
      company: stat.company,
      messagesProcessed: stat.messagesProcessed,
      lastExtractedAt: stat.lastExtractedAt,
    }));
  },
});

