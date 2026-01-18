/**
 * Task 7.6: Analyze conversations with LLM to generate action suggestions.
 *
 * This module processes queued conversations through OpenAI to determine
 * if user action is needed (respond, follow-up, etc.).
 */
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { actionTypeValidator, platformValidator } from "./schema";

/** Result from LLM analysis */
type AnalysisResult = "action_created" | "no_action" | "error";

// ============================================================================
// Internal queries for fetching data within actions
// ============================================================================

/**
 * Get the next pending queue entry ordered by priority.
 */
export const getNextPendingAnalysis = internalQuery({
  args: {},
  handler: async (ctx) => {
    return ctx.db
      .query("actionAnalysisQueue")
      .withIndex("by_priority", (q) => q.eq("status", "pending"))
      .order("desc") // Higher priority first
      .first();
  },
});

/**
 * Get queue entry by ID.
 */
export const getQueueEntry = internalQuery({
  args: { queueEntryId: v.id("actionAnalysisQueue") },
  handler: async (ctx, args) => {
    return ctx.db.get(args.queueEntryId);
  },
});

/**
 * Get conversation with participant contacts.
 */
export const getConversationContext = internalQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return null;

    // Get primary contact (first participant for DMs)
    let primaryContact: Doc<"contacts"> | null = null;
    if (conversation.participantContactIds.length > 0) {
      primaryContact = await ctx.db.get(conversation.participantContactIds[0]);
    }

    return {
      conversation,
      primaryContact,
    };
  },
});

/**
 * Get recent messages for a conversation.
 */
export const getRecentMessages = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId)
      )
      .order("desc")
      .take(args.limit);

    // Get sender contact names for non-user messages
    const enriched = await Promise.all(
      messages.map(async (msg) => {
        let senderName: string | undefined;
        if (msg.senderContactId) {
          const contact = await ctx.db.get(msg.senderContactId);
          senderName = contact?.displayName;
        }
        return {
          content: msg.content,
          isFromMe: msg.isFromMe,
          sentAt: msg.sentAt,
          senderName,
        };
      })
    );

    // Return in chronological order (oldest first)
    return enriched.reverse();
  },
});

/**
 * Check if a pending action already exists for this conversation.
 */
export const hasPendingAction = internalQuery({
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
 * Get recent actions for a conversation (to avoid duplicates).
 * Returns actions from the last 7 days, including discarded ones.
 */
export const getRecentActionsForConversation = internalQuery({
  args: {
    userId: v.id("users"),
    conversationId: v.id("conversations"),
    limit: v.optional(v.number()),
    daysBack: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 5;
    const daysBack = args.daysBack ?? 7;
    const cutoffTime = Date.now() - daysBack * 24 * 60 * 60 * 1000;

    // Get all actions for this user, then filter by conversation and time
    const actions = await ctx.db
      .query("actions")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .filter((q) =>
        q.and(
          q.eq(q.field("conversationId"), args.conversationId),
          q.gte(q.field("createdAt"), cutoffTime)
        )
      )
      .order("desc")
      .take(limit);

    // Return simplified action data for LLM context
    return actions.map((action) => ({
      type: action.type,
      status: action.status,
      createdAt: action.createdAt,
    }));
  },
});

// ============================================================================
// Internal mutations for updating state
// ============================================================================

/**
 * Mark analysis as started (processing).
 */
export const markAnalysisStarted = internalMutation({
  args: { queueEntryId: v.id("actionAnalysisQueue") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.queueEntryId, {
      status: "processing",
      startedAt: Date.now(),
    });
  },
});

/**
 * Mark analysis as completed with result.
 */
export const markAnalysisCompleted = internalMutation({
  args: {
    queueEntryId: v.id("actionAnalysisQueue"),
    result: v.union(
      v.literal("action_created"),
      v.literal("no_action"),
      v.literal("error")
    ),
    skipReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.queueEntryId, {
      status: "completed",
      completedAt: Date.now(),
      result: args.result,
      skipReason: args.skipReason,
    });
  },
});

/**
 * Mark analysis as skipped (filtered out).
 */
export const markAnalysisSkipped = internalMutation({
  args: {
    queueEntryId: v.id("actionAnalysisQueue"),
    skipReason: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.queueEntryId, {
      status: "skipped",
      completedAt: Date.now(),
      skipReason: args.skipReason,
    });
  },
});

/**
 * Create an action from LLM suggestion.
 * Atomically checks for existing pending action to prevent race conditions.
 */
export const createActionFromSuggestion = internalMutation({
  args: {
    userId: v.id("users"),
    conversationId: v.id("conversations"),
    contactId: v.optional(v.id("contacts")),
    type: actionTypeValidator,
    priority: v.number(),
    platform: platformValidator,
    draftMessage: v.optional(v.string()),
    llmReason: v.optional(v.string()),
    snoozedUntil: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Atomic check: prevent race condition where multiple events create duplicate actions
    const existingPending = await ctx.db
      .query("actions")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "pending")
      )
      .first();

    if (existingPending) {
      // Action already exists for this conversation, skip creation
      return null;
    }

    const isPending = !args.snoozedUntil;

    const actionId = await ctx.db.insert("actions", {
      userId: args.userId,
      type: args.type,
      status: isPending ? "pending" : "snoozed",
      priority: args.priority,
      conversationId: args.conversationId,
      contactId: args.contactId,
      platform: args.platform,
      draftMessage: args.draftMessage,
      llmReason: args.llmReason,
      snoozedUntil: args.snoozedUntil,
      createdAt: Date.now(),
    });

    // Increment pending action count if created as pending
    if (isPending) {
      const user = await ctx.db.get(args.userId);
      if (user) {
        await ctx.db.patch(args.userId, {
          pendingActionCount: (user.pendingActionCount ?? 0) + 1,
        });
      }
    }

    return actionId;
  },
});

// ============================================================================
// Main analysis action
// ============================================================================

interface AnalyzeConversationResult {
  success: boolean;
  result: AnalysisResult;
  actionId?: string;
  error?: string;
}

/**
 * Analyze a conversation with LLM to generate action suggestions.
 * This is a Convex action because it calls external APIs (OpenAI).
 */
export const analyzeConversation = internalAction({
  args: {
    queueEntryId: v.id("actionAnalysisQueue"),
  },
  handler: async (ctx, args): Promise<AnalyzeConversationResult> => {
    // Get queue entry
    const queueEntry = await ctx.runQuery(internal.actionAnalysis.getQueueEntry, {
      queueEntryId: args.queueEntryId,
    });

    if (!queueEntry) {
      return { success: false, result: "error", error: "Queue entry not found" };
    }

    if (queueEntry.status !== "pending") {
      return {
        success: false,
        result: "error",
        error: `Queue entry already ${queueEntry.status}`,
      };
    }

    // Mark as processing
    await ctx.runMutation(internal.actionAnalysis.markAnalysisStarted, {
      queueEntryId: args.queueEntryId,
    });

    try {
      // Check if pending action already exists (deduplication)
      const hasPending = await ctx.runQuery(
        internal.actionAnalysis.hasPendingAction,
        {
          userId: queueEntry.userId,
          conversationId: queueEntry.conversationId,
        }
      );

      if (hasPending) {
        await ctx.runMutation(internal.actionAnalysis.markAnalysisSkipped, {
          queueEntryId: args.queueEntryId,
          skipReason: "Pending action already exists",
        });
        return { success: true, result: "no_action" };
      }

      // Get conversation context
      const context = await ctx.runQuery(
        internal.actionAnalysis.getConversationContext,
        { conversationId: queueEntry.conversationId }
      );

      if (!context) {
        await ctx.runMutation(internal.actionAnalysis.markAnalysisCompleted, {
          queueEntryId: args.queueEntryId,
          result: "error",
          skipReason: "Conversation not found",
        });
        return { success: false, result: "error", error: "Conversation not found" };
      }

      const { conversation, primaryContact } = context;

      // Get recent messages
      const messages = await ctx.runQuery(
        internal.actionAnalysis.getRecentMessages,
        {
          conversationId: queueEntry.conversationId,
          limit: 10,
        }
      );

      if (messages.length === 0) {
        await ctx.runMutation(internal.actionAnalysis.markAnalysisCompleted, {
          queueEntryId: args.queueEntryId,
          result: "no_action",
          skipReason: "No messages in conversation",
        });
        return { success: true, result: "no_action" };
      }

      // Calculate hours since last message
      const lastMessage = messages[messages.length - 1];
      const hoursSinceLastMessage = lastMessage
        ? (Date.now() - lastMessage.sentAt) / (1000 * 60 * 60)
        : 0;

      // Get recent actions to avoid duplicates
      const recentActions = await ctx.runQuery(
        internal.actionAnalysis.getRecentActionsForConversation,
        {
          userId: queueEntry.userId,
          conversationId: queueEntry.conversationId,
          limit: 5,
          daysBack: 7,
        }
      );

      // Build input for LLM
      const { generateActionWithRetry, getMemories } = await import("@prm/ai");

      // Fetch memories about this contact for better context
      let contactMemories: Array<{ memory: string; createdAt?: string }> = [];
      if (primaryContact) {
        try {
          const memoryResults = await getMemories(
            primaryContact.displayName,
            {
              user_id: queueEntry.userId.toString(),
              filters: { contact_id: primaryContact._id.toString() },
            }
          );
          if (Array.isArray(memoryResults)) {
            contactMemories = memoryResults
              .filter((m): m is { memory: string; created_at?: string } => Boolean(m.memory))
              .slice(0, 10)
              .map((m) => ({
                memory: m.memory,
                createdAt: m.created_at,
              }));
          }
        } catch (e) {
          // Memory fetch is optional - continue without it
          console.log("Failed to fetch memories (non-blocking):", e);
        }
      }

      const suggestion = await generateActionWithRetry({
        contact: {
          displayName: primaryContact?.displayName ?? "Unknown",
          company: primaryContact?.company ?? undefined,
          notes: primaryContact?.notes ?? undefined,
          isKnownContact: primaryContact !== null,
          tags: primaryContact?.tags ?? undefined,
          importance: primaryContact?.importance ?? undefined,
        },
        messages,
        platform: conversation.platform,
        hoursSinceLastMessage,
        recentActions,
        contactMemories,
      });

      if (!suggestion.shouldCreateAction) {
        await ctx.runMutation(internal.actionAnalysis.markAnalysisCompleted, {
          queueEntryId: args.queueEntryId,
          result: "no_action",
          skipReason: suggestion.reason ?? "LLM determined no action needed",
        });
        return { success: true, result: "no_action" };
      }

      // Parse remindAt if provided
      let snoozedUntil: number | undefined;
      if (suggestion.remindAt) {
        const parsed = Date.parse(suggestion.remindAt);
        if (!isNaN(parsed)) {
          snoozedUntil = parsed;
        }
      }

      // Create the action
      const actionId = await ctx.runMutation(
        internal.actionAnalysis.createActionFromSuggestion,
        {
          userId: queueEntry.userId,
          conversationId: queueEntry.conversationId,
          contactId: primaryContact?._id,
          type: suggestion.type ?? "respond",
          priority: suggestion.priority ?? 50,
          platform: conversation.platform,
          draftMessage: suggestion.suggestedResponse ?? undefined,
          llmReason: suggestion.reason ?? undefined,
          snoozedUntil,
        }
      );

      await ctx.runMutation(internal.actionAnalysis.markAnalysisCompleted, {
        queueEntryId: args.queueEntryId,
        result: "action_created",
      });

      return {
        success: true,
        result: "action_created",
        actionId: actionId as string,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      await ctx.runMutation(internal.actionAnalysis.markAnalysisCompleted, {
        queueEntryId: args.queueEntryId,
        result: "error",
        skipReason: errorMessage,
      });

      return { success: false, result: "error", error: errorMessage };
    }
  },
});

/**
 * Process the next item in the analysis queue.
 * Returns true if an item was processed, false if queue is empty.
 */
export const processNextInQueue = action({
  args: {},
  handler: async (ctx): Promise<{ processed: boolean; result?: AnalysisResult }> => {
    const nextEntry = await ctx.runQuery(
      internal.actionAnalysis.getNextPendingAnalysis,
      {}
    );

    if (!nextEntry) {
      return { processed: false };
    }

    const result = await ctx.runAction(internal.actionAnalysis.analyzeConversation, {
      queueEntryId: nextEntry._id,
    });

    return { processed: true, result: result.result };
  },
});
