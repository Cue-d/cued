/**
 * Task 7.6: Analyze conversations with LLM to generate action suggestions.
 *
 * This module processes queued conversations through Vercel AI Gateway to determine
 * if user action is needed (respond, follow-up, etc.).
 */
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { resolveActionSummary } from "./lib/actionSummary";
import { actionTypeValidator, platformValidator } from "./schema";

/** Result from LLM analysis */
type AnalysisResult = "action_created" | "no_action" | "error";

/** Message type returned by getRecentMessages */
interface RecentMessage {
  _id: Id<"messages">;
  content: string;
  isFromMe: boolean;
  sentAt: number;
  senderName: string | undefined;
  reactions?: Array<{
    emoji: string;
    isFromMe: boolean;
    timestamp: number;
    reactorName?: string;
  }>;
}

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

    // Get all participant contacts
    const participants = await Promise.all(
      conversation.participantContactIds.map((id) => ctx.db.get(id))
    );
    const validParticipants = participants.filter(
      (p): p is Doc<"contacts"> => p !== null
    );
    const participantNames = validParticipants.map((p) => p.displayName);

    // Primary contact is first non-null participant (for DMs)
    // This handles the case where the first participant contact was deleted
    const primaryContact = validParticipants[0] ?? null;

    return {
      conversation,
      primaryContact,
      participantNames,
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

    const reactionContactIds = new Set<Id<"contacts">>();
    for (const msg of messages) {
      for (const reaction of msg.reactions ?? []) {
        if (!reaction.isFromMe && reaction.contactId) {
          reactionContactIds.add(reaction.contactId);
        }
      }
    }

    const reactionContactNameMap = new Map<Id<"contacts">, string>();
    await Promise.all(
      [...reactionContactIds].map(async (contactId) => {
        const contact = await ctx.db.get(contactId);
        if (contact?.displayName) {
          reactionContactNameMap.set(contactId, contact.displayName);
        }
      })
    );

    // Get sender contact names for non-user messages
    const enriched = await Promise.all(
      messages.map(async (msg) => {
        let senderName: string | undefined;
        if (msg.senderContactId) {
          const contact = await ctx.db.get(msg.senderContactId);
          senderName = contact?.displayName;
        }
        return {
          _id: msg._id,
          content: msg.content,
          isFromMe: msg.isFromMe,
          sentAt: msg.sentAt,
          senderName,
          reactions: msg.reactions?.map((reaction) => ({
            emoji: reaction.emoji,
            isFromMe: reaction.isFromMe,
            timestamp: reaction.timestamp,
            reactorName: reaction.isFromMe
              ? "Me"
              : reaction.contactId
                ? reactionContactNameMap.get(reaction.contactId)
                : undefined,
          })),
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
 * Returns action ID on success, or undefined if action already exists (race condition).
 */
export const createActionFromSuggestion = internalMutation({
  args: {
    userId: v.id("users"),
    conversationId: v.id("conversations"),
    contactId: v.optional(v.id("contacts")),
    messageId: v.optional(v.id("messages")), // Trigger message ID for embedding tracking
    type: actionTypeValidator,
    priority: v.number(),
    platform: platformValidator,
    summary: v.optional(v.string()),
    llmReason: v.optional(v.string()),
    snoozedUntil: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Id<"actions"> | undefined> => {
    // Atomic check: prevent race condition where multiple events create duplicate actions
    const existingPending = await ctx.db
      .query("actions")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "pending")
      )
      .first();

    if (existingPending) {
      // Action already exists for this conversation, skip creation
      return undefined;
    }

    const isPending = !args.snoozedUntil;

    const actionId = await ctx.db.insert("actions", {
      userId: args.userId,
      type: args.type,
      status: isPending ? "pending" : "snoozed",
      priority: args.priority,
      conversationId: args.conversationId,
      contactId: args.contactId,
      messageId: args.messageId,
      platform: args.platform,
      summary: resolveActionSummary(args.type, args.summary),
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
 * This is a Convex action because it calls external APIs (Vercel AI Gateway).
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

      const { conversation, primaryContact, participantNames } = context;

      // Get recent messages
      const messages: RecentMessage[] = await ctx.runQuery(
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

      // Process messages for embedding (find trigger, compute embedding, check skip)
      const embeddingResult = await ctx.runAction(
        internal.embeddings.processMessagesForEmbedding,
        {
          userId: queueEntry.userId,
          messages: messages.map((m) => ({
            _id: m._id,
            content: m.content,
            isFromMe: m.isFromMe,
            sentAt: m.sentAt,
            senderName: m.senderName,
            reactions: m.reactions,
          })),
          conversation: {
            platform: conversation.platform,
            conversationType: conversation.conversationType,
            displayName: conversation.displayName,
            workspaceId: conversation.workspaceId,
          },
          contactName: primaryContact?.displayName ?? "Unknown",
          participantNames,
        }
      );

      if (embeddingResult.shouldSkip) {
        await ctx.runMutation(internal.actionAnalysis.markAnalysisSkipped, {
          queueEntryId: args.queueEntryId,
          skipReason: embeddingResult.skipReason ?? "Similar messages historically dismissed",
        });
        return { success: true, result: "no_action" };
      }

      // Build input for LLM
      const { generateActionWithRetry } = await import("@cued/ai");

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
          contactId:
            conversation.conversationType === "dm"
              ? primaryContact?._id
              : undefined,
          messageId: embeddingResult.triggerMessageId,
          type: suggestion.type ?? "respond",
          priority: suggestion.priority ?? 50,
          platform: conversation.platform,
          summary: suggestion.summary ?? undefined,
          llmReason: suggestion.reason ?? undefined,
          snoozedUntil,
        }
      );

      // Race condition: another event created an action while we were analyzing
      if (!actionId) {
        await ctx.runMutation(internal.actionAnalysis.markAnalysisCompleted, {
          queueEntryId: args.queueEntryId,
          result: "no_action",
          skipReason: "Pending action already exists (race condition)",
        });
        return { success: true, result: "no_action" };
      }

      // Store embedding on the action (no separate table, no race condition)
      if (embeddingResult.embedding && embeddingResult.embeddingInput) {
        try {
          await ctx.runMutation(internal.embeddings.storeEmbedding, {
            actionId,
            embedding: embeddingResult.embedding,
            embeddingInput: embeddingResult.embeddingInput,
          });
        } catch (error) {
          // Non-critical, don't fail the action creation - but log for debugging
          console.error(
            `[ActionAnalysis] Failed to store embedding for action ${actionId}:`,
            error
          );
        }
      }

      await ctx.runMutation(internal.actionAnalysis.markAnalysisCompleted, {
        queueEntryId: args.queueEntryId,
        result: "action_created",
      });

      return {
        success: true,
        result: "action_created",
        actionId,
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
