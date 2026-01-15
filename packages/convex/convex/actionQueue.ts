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
// Task 7.17: EOD Contact Scan - Daily scan for new contacts
// ============================================================================

const MAX_EOD_CONTACTS_PER_DAY = 10; // Limit to avoid overwhelm

/**
 * Get contacts without enrichment (no notes or company) that have
 * recent conversations (from today).
 */
export const getNewContactsForEOD = internalQuery({
  args: {
    userId: v.id("users"),
    todayStartMs: v.number(), // Start of today in ms
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    // Get all contacts for user
    const contacts = await ctx.db
      .query("contacts")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();

    // Filter contacts that haven't been enriched
    const unenrichedContacts = contacts.filter(
      (c) => !c.notes && !c.company
    );

    // For each, check if they have a conversation from today
    const results: Array<{
      contact: Doc<"contacts">;
      conversation: Doc<"conversations"> | null;
      latestMessageAt: number;
    }> = [];

    for (const contact of unenrichedContacts) {
      // Find conversations where this contact is a participant
      const conversation = await ctx.db
        .query("conversations")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .filter((q) =>
          q.and(
            q.gte(q.field("lastMessageAt"), args.todayStartMs),
            // Check if contact is in participants
            // Note: This is a simplified check - in practice you might need more sophisticated matching
          )
        )
        .order("desc")
        .first();

      // Get any conversation with this contact
      const allConversations = await ctx.db
        .query("conversations")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .collect();

      const contactConv = allConversations.find(
        (c) => c.participantContactIds.includes(contact._id) &&
               (c.lastMessageAt ?? 0) >= args.todayStartMs
      );

      if (contactConv && contactConv.lastMessageAt) {
        results.push({
          contact,
          conversation: contactConv,
          latestMessageAt: contactConv.lastMessageAt,
        });
      }

      if (results.length >= args.limit) break;
    }

    // Sort by latest message time
    results.sort((a, b) => b.latestMessageAt - a.latestMessageAt);

    return results.slice(0, args.limit);
  },
});

/**
 * Check if a contact already has a pending EOD action.
 */
export const hasEODActionForContact = internalQuery({
  args: {
    userId: v.id("users"),
    contactId: v.id("contacts"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("actions")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", args.userId).eq("status", "pending")
      )
      .filter((q) =>
        q.and(
          q.eq(q.field("contactId"), args.contactId),
          q.eq(q.field("type"), "eod_contact")
        )
      )
      .first();

    return existing !== null;
  },
});

/**
 * Create an EOD contact action.
 */
export const createEODContactAction = internalMutation({
  args: {
    userId: v.id("users"),
    contactId: v.id("contacts"),
    conversationId: v.optional(v.id("conversations")),
    platform: platformValidator,
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actionId = await ctx.db.insert("actions", {
      userId: args.userId,
      type: "eod_contact",
      status: "pending",
      priority: 60, // Medium priority
      contactId: args.contactId,
      conversationId: args.conversationId,
      platform: args.platform,
      reason: args.reason ?? "New contact needs enrichment",
      createdAt: Date.now(),
    });

    // Increment pending action count
    const user = await ctx.db.get(args.userId);
    if (user) {
      await ctx.db.patch(args.userId, {
        pendingActionCount: (user.pendingActionCount ?? 0) + 1,
      });
    }

    return actionId;
  },
});

/**
 * Scan for new contacts for a specific user.
 * Task 7.17: Creates eod_contact actions for unenriched contacts.
 */
export const scanForNewContacts = internalAction({
  args: {
    userId: v.id("users"),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ found: number; created: number; skipped: number }> => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Get new contacts from today
    const newContacts: Array<{
      contact: Doc<"contacts">;
      conversation: Doc<"conversations"> | null;
      latestMessageAt: number;
    }> = await ctx.runQuery(internal.actionQueue.getNewContactsForEOD, {
      userId: args.userId,
      todayStartMs: todayStart.getTime(),
      limit: MAX_EOD_CONTACTS_PER_DAY,
    });

    let created = 0;
    let skipped = 0;

    for (const { contact, conversation } of newContacts) {
      // Check if already has pending EOD action
      const hasAction = await ctx.runQuery(
        internal.actionQueue.hasEODActionForContact,
        {
          userId: args.userId,
          contactId: contact._id,
        }
      );

      if (hasAction) {
        skipped++;
        continue;
      }

      // Create EOD action
      await ctx.runMutation(internal.actionQueue.createEODContactAction, {
        userId: args.userId,
        contactId: contact._id,
        conversationId: conversation?._id,
        platform: conversation?.platform ?? "imessage",
        reason: `New contact from today: ${contact.displayName}`,
      });

      created++;
    }

    return {
      found: newContacts.length,
      created,
      skipped,
    };
  },
});

/**
 * Scan all users for new contacts.
 * Task 7.17: Called by daily cron at 9 PM.
 */
export const scanAllUsersForNewContacts = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Get all users with connected integrations
    const integrations = await ctx.db
      .query("integrations")
      .filter((q) => q.eq(q.field("syncState.isConnected"), true))
      .collect();

    // Get unique user IDs
    const userIds = [...new Set(integrations.map((i) => i.userId))];

    const results: Array<{
      userId: string;
      scheduled: boolean;
    }> = [];

    for (const userId of userIds) {
      // Schedule the scan action for each user
      await ctx.scheduler.runAfter(
        0,
        internal.actionQueue.scanForNewContacts,
        { userId }
      );

      results.push({
        userId: userId as string,
        scheduled: true,
      });
    }

    return {
      usersScanned: results.length,
    };
  },
});

