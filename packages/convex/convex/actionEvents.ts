/**
 * Event-driven action creation system.
 *
 * Replaces cron-based scanning with event triggers on message sync.
 * - onIncomingMessage: Analyzes conversation when new message arrives
 * - onUserSentMessage: Auto-completes pending actions when user replies
 */
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { adjustPendingActionCount } from "./lib/actions";
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
    // @ts-ignore - TS2589: Type instantiation depth limit (known Convex issue)
    const hasPendingQuery = internal.actionEvents.hasPendingActionForConversation;
    const hasPending = await ctx.runQuery(hasPendingQuery, {
      conversationId: args.conversationId,
    });
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

    const { conversation, primaryContact, participantNames } = context;

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
    const { shouldSkipLlmAnalysis } = await import("@cued/ai");

    const filterResult = shouldSkipLlmAnalysis({
      text: lastMessage.content,
      personName: primaryContact?.displayName,
      isContact: primaryContact !== null,
    });

    if (filterResult.shouldSkip) {
      return { skipped: true, reason: filterResult.reason };
    }

    // 7. Process messages for embedding (find trigger, compute embedding, check skip)
    const embeddingResult = await ctx.runAction(
      internal.embeddings.processMessagesForEmbedding,
      {
        userId: args.userId,
        messages: messages.map((m) => ({
          _id: m._id,
          content: m.content,
          isFromMe: m.isFromMe,
          sentAt: m.sentAt,
          senderName: m.senderName,
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
      return { skipped: true, reason: embeddingResult.skipReason ?? "similar_dismissed" };
    }

    // 8. Calculate hours since last message
    const hoursSinceLastMessage = lastMessage
      ? (Date.now() - lastMessage.sentAt) / (1000 * 60 * 60)
      : 0;

    // 10. Get recent actions for LLM context
    const recentActions = await ctx.runQuery(
      internal.actionAnalysis.getRecentActionsForConversation,
      {
        userId: args.userId,
        conversationId: args.conversationId,
        limit: 5,
        daysBack: 7,
      }
    );

    // 11. Fetch contact memories (optional enhancement, non-blocking)
    const { generateActionWithRetry, fetchContactMemories } = await import("@cued/ai");

    const contactMemories = primaryContact
      ? await fetchContactMemories(
          primaryContact.displayName,
          args.userId.toString(),
          primaryContact._id.toString()
        )
      : [];

    // 12. Run LLM analysis
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

    // 13. Parse remindAt if provided
    let snoozedUntil: number | undefined;
    if (suggestion.remindAt) {
      const parsed = Date.parse(suggestion.remindAt);
      if (!isNaN(parsed)) {
        snoozedUntil = parsed;
      }
    }

    // 13. Create the action with messageId
    const actionId = await ctx.runMutation(
      internal.actionAnalysis.createActionFromSuggestion,
      {
        userId: args.userId,
        conversationId: args.conversationId,
        contactId: primaryContact?._id,
        messageId: embeddingResult.triggerMessageId,
        type: suggestion.type ?? "respond",
        priority: suggestion.priority ?? 50,
        platform: conversation.platform,
        llmReason: suggestion.reason ?? undefined,
        snoozedUntil,
      }
    );

    // 14. Handle race condition - another event created the action between our check and mutation
    if (!actionId) {
      return { skipped: true, reason: "pending_action_exists_race" };
    }

    // 15. Store embedding on the action (no separate table, no race condition)
    if (embeddingResult.embedding && embeddingResult.embeddingInput) {
      try {
        await ctx.runMutation(internal.embeddings.storeEmbedding, {
          actionId,
          embedding: embeddingResult.embedding,
          embeddingInput: embeddingResult.embeddingInput,
        });
      } catch (error) {
        // Non-critical, don't fail the action creation
        console.error(
          `[ActionEvents] Failed to store embedding for action ${actionId}:`,
          error
        );
      }
    }

    return {
      skipped: false,
      actionCreated: true,
      actionId,
    };
  },
});

// ============================================================================
// Batched event handlers
// ============================================================================

/**
 * Batch handler for user sent messages - processes multiple conversations in one call.
 * More efficient than O(n) scheduler calls for many conversations.
 */
export const onUserSentMessageBatch = internalMutation({
  args: {
    userId: v.id("users"),
    conversationIds: v.array(v.id("conversations")),
  },
  handler: async (ctx, args): Promise<{ totalCompleted: number }> => {
    let totalCompleted = 0;

    for (const conversationId of args.conversationIds) {
      const pendingActions = await ctx.db
        .query("actions")
        .withIndex("by_conversation_status", (q) =>
          q.eq("conversationId", conversationId).eq("status", "pending")
        )
        .collect();

      if (pendingActions.length === 0) continue;

      const now = Date.now();
      for (const action of pendingActions) {
        await ctx.db.patch(action._id, {
          status: "completed",
          completedAt: now,
          reason: "User sent message in conversation",
        });
      }

      await adjustPendingActionCount(ctx, args.userId, -pendingActions.length);
      totalCompleted += pendingActions.length;
    }

    return { totalCompleted };
  },
});

/**
 * Batch handler for incoming messages - schedules individual analysis actions.
 * Each conversation is processed independently via scheduler to avoid timeout issues.
 */
export const onIncomingMessageBatch = internalAction({
  args: {
    userId: v.id("users"),
    conversationIds: v.array(v.id("conversations")),
    platform: platformValidator,
  },
  handler: async (ctx, args): Promise<{ processed: number; skipped: number }> => {
    let processed = 0;
    let skipped = 0;

    // Process each conversation sequentially to avoid overwhelming the system
    // Each conversation's analysis is CPU/LLM intensive so we don't parallelize
    // TODO: For very large batches, this sequential processing could be slow.
    // Consider: (1) chunking into smaller batches with progress tracking,
    // (2) limited parallelism (e.g., Promise.all with concurrency limit),
    // (3) or moving to a queue-based approach for better scalability.
    for (const conversationId of args.conversationIds) {
      // 1. Check if pending action already exists
      const hasPending = await ctx.runQuery(
        internal.actionEvents.hasPendingActionForConversation,
        { conversationId }
      );
      if (hasPending) {
        skipped++;
        continue;
      }

      // 2. Check if snoozed action exists that hasn't expired
      const hasSnoozed = await ctx.runQuery(
        internal.actionEvents.hasActiveSnoozedAction,
        { conversationId }
      );
      if (hasSnoozed) {
        skipped++;
        continue;
      }

      // 3. Check if discarded action exists with no new messages since
      const latestDiscarded = await ctx.runQuery(
        internal.actionEvents.getLatestDiscardedAction,
        { conversationId }
      );
      if (latestDiscarded) {
        const latestMessageTime = await ctx.runQuery(
          internal.actionEvents.getLatestMessageTime,
          { conversationId }
        );
        if (latestMessageTime && latestMessageTime <= latestDiscarded.discardedAt) {
          skipped++;
          continue;
        }
      }

      // 4. Get conversation context
      const context = await ctx.runQuery(
        internal.actionAnalysis.getConversationContext,
        { conversationId }
      );
      if (!context) {
        skipped++;
        continue;
      }

      const { conversation, primaryContact, participantNames } = context;

      // 5. Get recent messages
      const messages = await ctx.runQuery(
        internal.actionAnalysis.getRecentMessages,
        { conversationId, limit: 10 }
      );
      if (messages.length === 0) {
        skipped++;
        continue;
      }

      // 6. Apply message filters (OTP, spam, etc.)
      const lastMessage = messages[messages.length - 1];
      const { shouldSkipLlmAnalysis } = await import("@cued/ai");

      const filterResult = shouldSkipLlmAnalysis({
        text: lastMessage.content,
        personName: primaryContact?.displayName,
        isContact: primaryContact !== null,
      });

      if (filterResult.shouldSkip) {
        skipped++;
        continue;
      }

      // 7. Process messages for embedding (find trigger, compute embedding, check skip)
      const embeddingResult = await ctx.runAction(
        internal.embeddings.processMessagesForEmbedding,
        {
          userId: args.userId,
          messages: messages.map((m) => ({
            _id: m._id,
            content: m.content,
            isFromMe: m.isFromMe,
            sentAt: m.sentAt,
            senderName: m.senderName,
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
        skipped++;
        continue;
      }

      // 8. Calculate hours since last message
      const hoursSinceLastMessage = lastMessage
        ? (Date.now() - lastMessage.sentAt) / (1000 * 60 * 60)
        : 0;

      // 10. Get recent actions for LLM context
      const recentActions = await ctx.runQuery(
        internal.actionAnalysis.getRecentActionsForConversation,
        {
          userId: args.userId,
          conversationId,
          limit: 5,
          daysBack: 7,
        }
      );

      // Fetch contact memories (optional enhancement)
      const { generateActionWithRetry, fetchContactMemories } = await import("@cued/ai");

      const contactMemories = primaryContact
        ? await fetchContactMemories(
            primaryContact.displayName,
            args.userId.toString(),
            primaryContact._id.toString()
          )
        : [];

      // 12. Run LLM analysis
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
        skipped++;
        continue;
      }

      // 13. Parse remindAt if provided
      let snoozedUntil: number | undefined;
      if (suggestion.remindAt) {
        const parsed = Date.parse(suggestion.remindAt);
        if (!isNaN(parsed)) {
          snoozedUntil = parsed;
        }
      }

      // 12. Create the action with messageId
      const actionId = await ctx.runMutation(
        internal.actionAnalysis.createActionFromSuggestion,
        {
          userId: args.userId,
          conversationId,
          contactId: primaryContact?._id,
          messageId: embeddingResult.triggerMessageId,
          type: suggestion.type ?? "respond",
          priority: suggestion.priority ?? 50,
          platform: conversation.platform,
          llmReason: suggestion.reason ?? undefined,
          snoozedUntil,
        }
      );

      // 13. Store embedding on the action (no separate table, no race condition)
      if (actionId && embeddingResult.embedding && embeddingResult.embeddingInput) {
        try {
          await ctx.runMutation(internal.embeddings.storeEmbedding, {
            actionId,
            embedding: embeddingResult.embedding,
            embeddingInput: embeddingResult.embeddingInput,
          });
        } catch (error) {
          // Non-critical, don't fail the action creation
          console.error(
            `[ActionEvents] Failed to store embedding for action ${actionId}:`,
            error
          );
        }
      }

      processed++;
    }

    return { processed, skipped };
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
