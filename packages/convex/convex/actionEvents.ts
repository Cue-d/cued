/**
 * Event-driven action creation system.
 *
 * Replaces cron-based scanning with event triggers on message sync.
 * - onIncomingMessage: Analyzes conversation when new message arrives
 * - onUserSentMessage: Auto-completes pending actions when user replies
 */
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { platformValidator } from "./schema";

// ============================================================================
// Internal queries
// ============================================================================

/**
 * Check if a pending action exists for this conversation.
 */
export const hasPendingActionForConversation = internalQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("actions")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "pending")
      )
      .first();
    return existing !== null;
  },
});

/**
 * Check if a snoozed action exists that hasn't expired yet.
 */
export const hasActiveSnoozedAction = internalQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const now = Date.now();
    const snoozed = await ctx.db
      .query("actions")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "snoozed")
      )
      .collect();

    // Check if any snoozed action hasn't expired yet
    return snoozed.some((a) => a.snoozedUntil && a.snoozedUntil > now);
  },
});

/**
 * Get the most recent discarded action for a conversation.
 * Used to determine if new messages have arrived since discard.
 */
export const getLatestDiscardedAction = internalQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const discarded = await ctx.db
      .query("actions")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "discarded")
      )
      .order("desc")
      .first();

    if (!discarded) return null;

    return {
      discardedAt: discarded.discardedAt ?? discarded.createdAt,
    };
  },
});

/**
 * Get the latest message timestamp for a conversation.
 */
export const getLatestMessageTime = internalQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    return conversation?.lastMessageAt ?? null;
  },
});

// ============================================================================
// Internal mutations
// ============================================================================

/**
 * Helper to adjust the pending action count on a user.
 */
async function adjustPendingActionCount(
  ctx: MutationCtx,
  userId: Id<"users">,
  delta: number
): Promise<void> {
  const user = await ctx.db.get(userId);
  if (!user) return;

  const currentCount = user.pendingActionCount ?? 0;
  const newCount = Math.max(0, currentCount + delta);
  await ctx.db.patch(userId, { pendingActionCount: newCount });
}

// ============================================================================
// Event handlers
// ============================================================================

/**
 * Handle user sending a message - auto-complete any pending actions.
 * Called from sync.ts when isFromMe message is inserted.
 */
export const onUserSentMessage = internalMutation({
  args: {
    userId: v.id("users"),
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args): Promise<{ completed: number }> => {
    const pendingActions = await ctx.db
      .query("actions")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "pending")
      )
      .collect();

    if (pendingActions.length === 0) return { completed: 0 };

    const now = Date.now();
    for (const action of pendingActions) {
      await ctx.db.patch(action._id, {
        status: "completed",
        completedAt: now,
        reason: "User sent message in conversation",
      });
    }

    await adjustPendingActionCount(ctx, args.userId, -pendingActions.length);

    return { completed: pendingActions.length };
  },
});

/** Result type for onIncomingMessage */
type IncomingMessageResult =
  | { skipped: true; reason: string | undefined }
  | { skipped: false; actionCreated: true; actionId: string };

/**
 * Handle incoming message - analyze conversation for potential action.
 * Called from sync.ts when non-user message is inserted.
 */
export const onIncomingMessage = internalAction({
  args: {
    userId: v.id("users"),
    conversationId: v.id("conversations"),
    platform: platformValidator,
  },
  handler: async (ctx, args): Promise<IncomingMessageResult> => {
    // 1. Check if pending action already exists
    const hasPending = await ctx.runQuery(
      internal.actionEvents.hasPendingActionForConversation,
      { conversationId: args.conversationId }
    );
    if (hasPending) {
      return { skipped: true, reason: "pending_action_exists" };
    }

    // 2. Check if snoozed action exists that hasn't expired
    const hasSnoozed = await ctx.runQuery(
      internal.actionEvents.hasActiveSnoozedAction,
      { conversationId: args.conversationId }
    );
    if (hasSnoozed) {
      return { skipped: true, reason: "snoozed_action_active" };
    }

    // 3. Check if discarded action exists with no new messages since
    const latestDiscarded = await ctx.runQuery(
      internal.actionEvents.getLatestDiscardedAction,
      { conversationId: args.conversationId }
    );
    if (latestDiscarded) {
      const latestMessageTime = await ctx.runQuery(
        internal.actionEvents.getLatestMessageTime,
        { conversationId: args.conversationId }
      );
      // Skip if no messages after discard (shouldn't happen since we're triggered by new message)
      // But check anyway for safety - the message that triggered us should be newer
      if (latestMessageTime && latestMessageTime <= latestDiscarded.discardedAt) {
        return { skipped: true, reason: "no_new_messages_since_discard" };
      }
    }

    // 4. Get conversation context
    const context = await ctx.runQuery(
      internal.actionAnalysis.getConversationContext,
      { conversationId: args.conversationId }
    );
    if (!context) {
      return { skipped: true, reason: "conversation_not_found" };
    }

    const { conversation, primaryContact } = context;

    // 5. Get recent messages
    const messages = await ctx.runQuery(
      internal.actionAnalysis.getRecentMessages,
      { conversationId: args.conversationId, limit: 10 }
    );
    if (messages.length === 0) {
      return { skipped: true, reason: "no_messages" };
    }

    // 6. Apply message filters (OTP, spam, etc.)
    const lastMessage = messages[messages.length - 1];
    const { shouldSkipLlmAnalysis } = await import("@prm/ai");

    const filterResult = shouldSkipLlmAnalysis({
      text: lastMessage.content,
      personName: primaryContact?.displayName,
      isContact: primaryContact !== null,
    });

    if (filterResult.shouldSkip) {
      return { skipped: true, reason: filterResult.reason };
    }

    // 7. Calculate hours since last message
    const hoursSinceLastMessage = lastMessage
      ? (Date.now() - lastMessage.sentAt) / (1000 * 60 * 60)
      : 0;

    // 8. Get recent actions for LLM context
    const recentActions = await ctx.runQuery(
      internal.actionAnalysis.getRecentActionsForConversation,
      {
        userId: args.userId,
        conversationId: args.conversationId,
        limit: 5,
        daysBack: 7,
      }
    );

    // 9. Fetch contact memories (optional enhancement, non-blocking)
    const { generateActionWithRetry, fetchContactMemories } = await import("@prm/ai");

    const contactMemories = primaryContact
      ? await fetchContactMemories(
          primaryContact.displayName,
          args.userId.toString(),
          primaryContact._id.toString()
        )
      : [];

    // 10. Run LLM analysis
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
      return { skipped: true, reason: suggestion.reason ?? "llm_no_action" };
    }

    // 11. Parse remindAt if provided
    let snoozedUntil: number | undefined;
    if (suggestion.remindAt) {
      const parsed = Date.parse(suggestion.remindAt);
      if (!isNaN(parsed)) {
        snoozedUntil = parsed;
      }
    }

    // 12. Create the action
    const actionId = await ctx.runMutation(
      internal.actionAnalysis.createActionFromSuggestion,
      {
        userId: args.userId,
        conversationId: args.conversationId,
        contactId: primaryContact?._id,
        type: suggestion.type ?? "respond",
        priority: suggestion.priority ?? 50,
        platform: conversation.platform,
        llmReason: suggestion.reason ?? undefined,
        snoozedUntil,
      }
    );

    return {
      skipped: false,
      actionCreated: true,
      actionId: actionId as string,
    };
  },
});

// ============================================================================
// Snoozed action wake-up (called by cron)
// ============================================================================

/**
 * Wake up snoozed actions that are due.
 * Converts snoozed actions to pending when snoozedUntil <= now.
 */
export const wakeSnoozedActions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let wokenCount = 0;

    // Get all snoozed actions across all users
    const snoozedActions = await ctx.db
      .query("actions")
      .filter((q) => q.eq(q.field("status"), "snoozed"))
      .collect();

    for (const action of snoozedActions) {
      if (action.snoozedUntil && action.snoozedUntil <= now) {
        await ctx.db.patch(action._id, {
          status: "pending",
          snoozedUntil: undefined,
        });

        // Increment pending count
        await adjustPendingActionCount(ctx, action.userId, 1);
        wokenCount++;
      }
    }

    return { wokenCount };
  },
});
