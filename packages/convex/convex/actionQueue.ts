/**
 * Task 7.5 & 7.7: Action queue management - scanning and processing.
 *
 * - scanForUnansweredConversations: Finds conversations needing action
 * - triggerQueueProcessing: Schedules LLM analysis for queued conversations
 */
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { platformValidator } from "./schema";

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

/**
 * Get conversations with unanswered messages for a user.
 * Returns conversations where:
 * - Last message is not from the user
 * - Last message is older than threshold hours
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
    const candidates = conversations.filter(
      (c) => c.lastMessageAt && c.lastMessageAt < cutoffTime
    );

    // For each candidate, check if last message is from user
    const results: Array<{
      conversation: Doc<"conversations">;
      lastMessage: Doc<"messages"> | null;
      primaryContact: Doc<"contacts"> | null;
    }> = [];

    for (const conv of candidates.slice(0, args.limit)) {
      // Get the last message
      const lastMessage = await ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conv._id))
        .order("desc")
        .first();

      // Skip if last message is from user (waiting for reply)
      if (!lastMessage || lastMessage.isFromMe) {
        continue;
      }

      // Get primary contact
      const primaryContact = conv.participantContactIds.length > 0
        ? await ctx.db.get(conv.participantContactIds[0])
        : null;

      results.push({
        conversation: conv,
        lastMessage,
        primaryContact,
      });
    }

    return results;
  },
});

/**
 * Check if conversation is already queued or was recently analyzed.
 */
export const isAlreadyQueued = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    gracePeriodMs: v.number(),
  },
  handler: async (ctx, args) => {
    // Check for pending or processing entry
    const pending = await ctx.db
      .query("actionAnalysisQueue")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId)
      )
      .filter((q) =>
        q.or(
          q.eq(q.field("status"), "pending"),
          q.eq(q.field("status"), "processing")
        )
      )
      .first();

    if (pending) return true;

    // Check for recently completed entry
    const graceCutoff = Date.now() - args.gracePeriodMs;
    const recentlyCompleted = await ctx.db
      .query("actionAnalysisQueue")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId)
      )
      .filter((q) =>
        q.and(
          q.eq(q.field("status"), "completed"),
          q.gte(q.field("completedAt"), graceCutoff)
        )
      )
      .first();

    return recentlyCompleted !== null;
  },
});

/**
 * Check if a pending action exists for this conversation.
 */
export const hasPendingActionForConversation = internalQuery({
  args: {
    userId: v.id("users"),
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("actions")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", args.userId).eq("status", "pending")
      )
      .filter((q) => q.eq(q.field("conversationId"), args.conversationId))
      .first();
    return existing !== null;
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
 * Uses internalAction because it needs to import @prm/ai for filtering.
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
    const conversations = await ctx.runQuery(
      internal.actionQueue.getUnansweredConversations,
      {
        userId: args.userId,
        thresholdMs,
        limit: MAX_QUEUE_PER_RUN,
      }
    );

    // Import filters dynamically
    const { shouldSkipLlmAnalysis, calculatePriority } = await import("@prm/ai");

    for (const { conversation, lastMessage, primaryContact } of conversations) {
      result.processed++;

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
        internal.actionQueue.hasPendingActionForConversation,
        {
          userId: args.userId,
          conversationId: conversation._id,
        }
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

// ============================================================================
// Task 7.7: Process analysis queue
// ============================================================================

/**
 * Get queue stats for monitoring.
 */
export const getQueueStats = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const user = await ctx.db
      .query("users")
      .withIndex("by_workos_id", (q) => q.eq("workosUserId", identity.subject))
      .unique();

    if (!user) return null;

    const pending = await ctx.db
      .query("actionAnalysisQueue")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", user._id).eq("status", "pending")
      )
      .collect();

    const processing = await ctx.db
      .query("actionAnalysisQueue")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", user._id).eq("status", "processing")
      )
      .collect();

    // Get today's completed count
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const completed = await ctx.db
      .query("actionAnalysisQueue")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", user._id).eq("status", "completed")
      )
      .filter((q) => q.gte(q.field("completedAt"), todayStart.getTime()))
      .collect();

    return {
      pending: pending.length,
      processing: processing.length,
      completedToday: completed.length,
    };
  },
});

/**
 * Trigger processing of the analysis queue.
 * Task 7.7: Schedules the analyzeConversation action.
 * Called by cron every 30 seconds.
 */
export const triggerQueueProcessing = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Get next pending entry
    const nextEntry = await ctx.db
      .query("actionAnalysisQueue")
      .withIndex("by_priority", (q) => q.eq("status", "pending"))
      .order("desc")
      .first();

    if (!nextEntry) {
      return { scheduled: false, reason: "Queue empty" };
    }

    // Schedule the action to run immediately
    await ctx.scheduler.runAfter(0, internal.actionAnalysis.analyzeConversation, {
      queueEntryId: nextEntry._id,
    });

    return { scheduled: true, queueEntryId: nextEntry._id };
  },
});

/**
 * Scan all users for unanswered conversations.
 * Called by cron - iterates through all connected integrations.
 */
export const scanAllUsersForUnanswered = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Get all connected integrations
    const integrations = await ctx.db
      .query("integrations")
      .filter((q) => q.eq(q.field("syncState.isConnected"), true))
      .collect();

    const results: Array<{
      userId: string;
      platform: string;
      queued: number;
      filtered: number;
    }> = [];

    for (const integration of integrations) {
      // Schedule the scan action to run immediately
      // (Can't call actions directly from mutations, so we schedule them)
      await ctx.scheduler.runAfter(
        0,
        internal.actionQueue.scanForUnansweredConversations,
        {
          userId: integration.userId,
          platform: integration.platform,
        }
      );

      results.push({
        userId: integration.userId as string,
        platform: integration.platform,
        queued: 0, // Will be populated by the scheduled action
        filtered: 0,
      });
    }

    return {
      usersScanned: results.length,
      totalQueued: results.reduce((sum, r) => sum + r.queued, 0),
      totalFiltered: results.reduce((sum, r) => sum + r.filtered, 0),
    };
  },
});

// ============================================================================
// Manual testing functions (public for dashboard/API access)
// ============================================================================

/**
 * Internal query to get user by WorkOS ID.
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
 * Manual trigger: Scan current user's conversations for unanswered messages.
 * Use this from Convex dashboard to test the scan flow.
 */
export const testScanForUnanswered = action({
  args: {
    platform: platformValidator,
  },
  handler: async (ctx, args): Promise<ScanResult & { error?: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { processed: 0, queued: 0, skipped: 0, filtered: 0, error: "Not authenticated" };
    }

    const user = await ctx.runQuery(internal.actionQueue.getUserByWorkosId, {
      workosUserId: identity.subject,
    });

    if (!user) {
      return { processed: 0, queued: 0, skipped: 0, filtered: 0, error: "User not found" };
    }

    return ctx.runAction(internal.actionQueue.scanForUnansweredConversations, {
      userId: user._id,
      platform: args.platform,
    });
  },
});

/**
 * Manual trigger: Process the next item in the queue.
 * Use this from Convex dashboard to test the processing flow.
 */
export const testProcessQueue = mutation({
  args: {},
  handler: async (ctx): Promise<{ scheduled: boolean; queueEntryId?: string; reason?: string; error?: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { scheduled: false, error: "Not authenticated" };
    }

    const result = await ctx.runMutation(internal.actionQueue.triggerQueueProcessing, {});
    return {
      scheduled: result.scheduled,
      queueEntryId: result.queueEntryId as string | undefined,
      reason: result.reason,
    };
  },
});

/**
 * Debug: Get conversations that would be picked up by the scanner.
 * Shows what conversations meet the criteria without actually queuing them.
 */
export const debugGetUnansweredCandidates = query({
  args: {
    thresholdHours: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const user = await ctx.db
      .query("users")
      .withIndex("by_workos_id", (q) => q.eq("workosUserId", identity.subject))
      .unique();

    if (!user) return null;

    const thresholdMs = (args.thresholdHours ?? UNANSWERED_THRESHOLD_HOURS) * 60 * 60 * 1000;
    const cutoffTime = Date.now() - thresholdMs;

    // Get recent conversations
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_last_message", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(20);

    const results = [];

    for (const conv of conversations) {
      // Get last message
      const lastMessage = await ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conv._id))
        .order("desc")
        .first();

      // Get primary contact
      const primaryContact = conv.participantContactIds.length > 0
        ? await ctx.db.get(conv.participantContactIds[0])
        : null;

      const hoursSince = lastMessage
        ? (Date.now() - lastMessage.sentAt) / (1000 * 60 * 60)
        : null;

      results.push({
        conversationId: conv._id,
        platform: conv.platform,
        contactName: primaryContact?.displayName ?? "Unknown",
        lastMessageAt: conv.lastMessageAt,
        lastMessagePreview: lastMessage?.content?.slice(0, 100),
        lastMessageIsFromMe: lastMessage?.isFromMe,
        hoursSinceLastMessage: hoursSince ? Math.round(hoursSince * 10) / 10 : null,
        meetsThreshold: conv.lastMessageAt ? conv.lastMessageAt < cutoffTime : false,
        wouldBeQueued: lastMessage && !lastMessage.isFromMe && conv.lastMessageAt && conv.lastMessageAt < cutoffTime,
      });
    }

    return {
      thresholdHours: args.thresholdHours ?? UNANSWERED_THRESHOLD_HOURS,
      cutoffTime: new Date(cutoffTime).toISOString(),
      conversations: results,
    };
  },
});

/**
 * Debug: Get raw stats without auth (for dashboard testing).
 * Shows conversation counts and recent data.
 */
export const debugRawStats = query({
  args: {},
  handler: async (ctx) => {
    // Get all users
    const users = await ctx.db.query("users").take(10);

    const stats = [];
    for (const user of users) {
      const conversations = await ctx.db
        .query("conversations")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .take(100);

      const queueEntries = await ctx.db
        .query("actionAnalysisQueue")
        .withIndex("by_user_status", (q) => q.eq("userId", user._id))
        .take(50);

      const actions = await ctx.db
        .query("actions")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .take(50);

      // Get a sample conversation with messages
      let sampleConversation = null;
      if (conversations.length > 0) {
        const conv = conversations[0];
        const messages = await ctx.db
          .query("messages")
          .withIndex("by_conversation", (q) => q.eq("conversationId", conv._id))
          .order("desc")
          .take(3);

        sampleConversation = {
          platform: conv.platform,
          lastMessageAt: conv.lastMessageAt ? new Date(conv.lastMessageAt).toISOString() : null,
          messageCount: messages.length,
          lastMessagePreview: messages[0]?.content?.slice(0, 50),
          lastMessageIsFromMe: messages[0]?.isFromMe,
        };
      }

      stats.push({
        userId: user._id,
        email: user.email,
        conversationCount: conversations.length,
        queueEntryCount: queueEntries.length,
        queueByStatus: {
          pending: queueEntries.filter(e => e.status === "pending").length,
          processing: queueEntries.filter(e => e.status === "processing").length,
          completed: queueEntries.filter(e => e.status === "completed").length,
          skipped: queueEntries.filter(e => e.status === "skipped").length,
        },
        actionCount: actions.length,
        pendingActions: actions.filter(a => a.status === "pending").length,
        sampleConversation,
      });
    }

    return { users: stats };
  },
});

/**
 * Debug: Get current queue status with details.
 */
export const debugGetQueueDetails = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const user = await ctx.db
      .query("users")
      .withIndex("by_workos_id", (q) => q.eq("workosUserId", identity.subject))
      .unique();

    if (!user) return null;

    // Get all queue entries for this user
    const entries = await ctx.db
      .query("actionAnalysisQueue")
      .withIndex("by_user_status", (q) => q.eq("userId", user._id))
      .take(50);

    // Enrich with conversation info
    const enriched = await Promise.all(
      entries.map(async (entry) => {
        const conversation = await ctx.db.get(entry.conversationId);
        const primaryContact = conversation?.participantContactIds[0]
          ? await ctx.db.get(conversation.participantContactIds[0])
          : null;

        return {
          _id: entry._id,
          status: entry.status,
          priority: entry.priority,
          queuedAt: new Date(entry.queuedAt).toISOString(),
          completedAt: entry.completedAt ? new Date(entry.completedAt).toISOString() : null,
          result: entry.result,
          skipReason: entry.skipReason,
          conversationId: entry.conversationId,
          platform: conversation?.platform,
          contactName: primaryContact?.displayName ?? "Unknown",
        };
      })
    );

    return {
      total: enriched.length,
      byStatus: {
        pending: enriched.filter((e) => e.status === "pending").length,
        processing: enriched.filter((e) => e.status === "processing").length,
        completed: enriched.filter((e) => e.status === "completed").length,
        skipped: enriched.filter((e) => e.status === "skipped").length,
      },
      entries: enriched,
    };
  },
});
