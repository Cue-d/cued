/**
 * Task 7.5 & 7.7: Action queue management - scanning and processing.
 *
 * - scanForUnansweredConversations: Finds conversations needing action
 * - triggerQueueProcessing: Schedules LLM analysis for queued conversations
 */
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { resolveActionSummary } from "./lib/actionSummary";
import { findUserByWorkosId } from "./lib/auth";
import { platformValidator } from "./schema";
import { isContactActionable } from "./lib/contactStatus";

// Constants
const UNANSWERED_THRESHOLD_HOURS = 2; // Hours before considering message unanswered
const GRACE_PERIOD_HOURS = 6; // Don't re-analyze within this window
const MAX_QUEUE_PER_RUN = 50; // Max conversations to queue per scan

// ============================================================================
// Task 7.5: Scan for unanswered conversations
// ============================================================================

interface ScanResult {
  processed: number;
  queued: number;
  skipped: number;
  filtered: number;
}

// Type for getUnansweredConversations return (breaks TS2589 type depth limit)
interface UnansweredConversation {
  conversation: Doc<"conversations">;
  lastMessage: Doc<"messages">;
  primaryContact: Doc<"contacts"> | null;
}

/**
 * Get conversations with unanswered messages for a user.
 * Returns conversations where:
 * - Last message is not from the user
 * - Last message is older than threshold hours
 * Optimized: batches message and contact fetches to avoid N+1.
 */
export const getUnansweredConversations = internalQuery({
  args: {
    userId: v.id("users"),
    thresholdMs: v.number(), // Threshold in milliseconds
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const cutoffTime = Date.now() - args.thresholdMs;

    // Get recent conversations with messages
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_last_message", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(args.limit * 2); // Fetch extra to filter

    // Filter: last message before cutoff (potentially unanswered)
    const candidates = conversations
      .filter((c) => c.lastMessageAt && c.lastMessageAt < cutoffTime)
      .slice(0, args.limit);

    if (candidates.length === 0) return [];

    // Batch fetch last messages for all candidates in parallel
    const lastMessages = await Promise.all(
      candidates.map((conv) =>
        ctx.db
          .query("messages")
          .withIndex("by_conversation", (q) => q.eq("conversationId", conv._id))
          .order("desc")
          .first()
      )
    );

    // Filter to only conversations where last message is NOT from user
    const validPairs = candidates
      .map((conv, i) => ({ conv, msg: lastMessages[i] }))
      .filter(
        (pair): pair is { conv: Doc<"conversations">; msg: Doc<"messages"> } =>
          pair.msg !== null && !pair.msg.isFromMe
      );

    if (validPairs.length === 0) return [];

    // Collect unique contact IDs and batch fetch
    const contactIds = [
      ...new Set(
        validPairs
          .map((p) => p.conv.participantContactIds[0])
          .filter((id): id is Id<"contacts"> => id !== undefined)
      ),
    ];
    const contacts = await Promise.all(contactIds.map((id) => ctx.db.get(id)));
    const contactMap = new Map(
      contactIds.map((id, i) => [id, contacts[i]])
    );

    // Build results
    return validPairs.map(({ conv, msg }) => ({
      conversation: conv,
      lastMessage: msg,
      primaryContact: conv.participantContactIds[0]
        ? contactMap.get(conv.participantContactIds[0]) ?? null
        : null,
    }));
  },
});

/**
 * Check if conversation is already queued or was recently analyzed.
 * Uses by_conversation_status index for efficient lookups.
 */
export const isAlreadyQueued = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    gracePeriodMs: v.number(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    // Check for pending or processing entries in parallel
    const [pending, processing] = await Promise.all([
      ctx.db
        .query("actionAnalysisQueue")
        .withIndex("by_conversation_status", (q) =>
          q.eq("conversationId", args.conversationId).eq("status", "pending")
        )
        .first(),
      ctx.db
        .query("actionAnalysisQueue")
        .withIndex("by_conversation_status", (q) =>
          q.eq("conversationId", args.conversationId).eq("status", "processing")
        )
        .first(),
    ]);

    if (pending || processing) return true;

    // Check for recently completed entry
    const graceCutoff = Date.now() - args.gracePeriodMs;
    const recentlyCompleted = await ctx.db
      .query("actionAnalysisQueue")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "completed")
      )
      .filter((q) => q.gte(q.field("completedAt"), graceCutoff))
      .first();

    return recentlyCompleted !== null;
  },
});


/**
 * Queue a conversation for LLM analysis.
 */
export const queueForAnalysis = internalMutation({
  args: {
    userId: v.id("users"),
    conversationId: v.id("conversations"),
    priority: v.number(),
  },
  handler: async (ctx, args) => {
    const queueId = await ctx.db.insert("actionAnalysisQueue", {
      userId: args.userId,
      conversationId: args.conversationId,
      status: "pending",
      priority: args.priority,
      queuedAt: Date.now(),
    });
    return queueId;
  },
});

/**
 * Mark a conversation as skipped in the queue.
 */
export const markAsSkipped = internalMutation({
  args: {
    userId: v.id("users"),
    conversationId: v.id("conversations"),
    skipReason: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("actionAnalysisQueue", {
      userId: args.userId,
      conversationId: args.conversationId,
      status: "skipped",
      priority: 0,
      queuedAt: Date.now(),
      completedAt: Date.now(),
      skipReason: args.skipReason,
    });
  },
});

/**
 * Scan for unanswered conversations and queue for LLM analysis.
 * Task 7.5: Called by cron every 5 minutes.
 * Uses internalAction because it needs to import @cued/ai for filtering.
 */
export const scanForUnansweredConversations = internalAction({
  args: {
    userId: v.id("users"),
    platform: platformValidator,
  },
  handler: async (ctx, args): Promise<ScanResult> => {
    const result: ScanResult = {
      processed: 0,
      queued: 0,
      skipped: 0,
      filtered: 0,
    };

    const thresholdMs = UNANSWERED_THRESHOLD_HOURS * 60 * 60 * 1000;
    const gracePeriodMs = GRACE_PERIOD_HOURS * 60 * 60 * 1000;

    // Get unanswered conversations
    const conversations = (await ctx.runQuery(
      internal.actionQueue.getUnansweredConversations,
      {
        userId: args.userId,
        thresholdMs,
        limit: MAX_QUEUE_PER_RUN,
      }
    )) as UnansweredConversation[];

    // Import filters dynamically
    const { shouldSkipLlmAnalysis, calculatePriority } = await import("@cued/ai");

    for (const { conversation, lastMessage, primaryContact } of conversations) {
      result.processed++;

      // Skip if primary contact is not active (archived)
      if (
        conversation.conversationType !== "group" &&
        primaryContact &&
        !isContactActionable(primaryContact)
      ) {
        result.skipped++;
        continue;
      }

      // Skip if already queued or recently analyzed
      const alreadyQueued = await ctx.runQuery(
        internal.actionQueue.isAlreadyQueued,
        {
          conversationId: conversation._id,
          gracePeriodMs,
        }
      );

      if (alreadyQueued) {
        result.skipped++;
        continue;
      }

      // Skip if pending action already exists
      const hasPending = await ctx.runQuery(
        internal.actionEvents.hasPendingActionForConversation,
        { conversationId: conversation._id }
      );

      if (hasPending) {
        result.skipped++;
        continue;
      }

      // Apply message filters
      if (lastMessage) {
        const filterResult = shouldSkipLlmAnalysis({
          identifier: primaryContact?.displayName ?? "unknown",
          text: lastMessage.content,
          personName: primaryContact?.displayName,
          isContact: primaryContact !== null,
        });

        if (filterResult.shouldSkip) {
          await ctx.runMutation(internal.actionQueue.markAsSkipped, {
            userId: args.userId,
            conversationId: conversation._id,
            skipReason: filterResult.reason ?? "filtered",
          });
          result.filtered++;
          continue;
        }
      }

      // Calculate priority
      const hoursSince = lastMessage
        ? (Date.now() - lastMessage.sentAt) / (1000 * 60 * 60)
        : 0;

      const priority = calculatePriority({
        hoursSince,
        contact: primaryContact
          ? {
              isContact: true,
              company: primaryContact.company,
              notes: primaryContact.notes,
            }
          : undefined,
        isGroup: conversation.conversationType === "group",
      });

      // Queue for analysis
      await ctx.runMutation(internal.actionQueue.queueForAnalysis, {
        userId: args.userId,
        conversationId: conversation._id,
        priority,
      });
      result.queued++;
    }

    return result;
  },
});

/**
 * Manually trigger scan for unanswered conversations (for testing).
 * Public mutation to allow manual testing.
 */
export const triggerScanForUnanswered = mutation({
  args: {
    platform: v.optional(platformValidator),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");

    const user = await findUserByWorkosId(ctx, identity.subject);

    if (!user) throw new Error("User not found");

    // Scan specific platform or all platforms
    const platforms = args.platform
      ? [args.platform]
      : (["imessage", "slack", "linkedin"] as const);

    for (const platform of platforms) {
      await ctx.scheduler.runAfter(
        0,
        internal.actionQueue.scanForUnansweredConversations,
        { userId: user._id, platform }
      );
    }

    return { success: true, message: `Scan scheduled for ${platforms.join(", ")}` };
  },
});
