/**
 * Action embeddings for action intelligence.
 * Enables similarity search to skip LLM for historically dismissed patterns.
 * Embeddings are stored directly on actions (no separate table, no race conditions).
 */
import { v } from "convex/values";
import {
  SIMILARITY_THRESHOLD,
  DISMISS_THRESHOLD,
  SIMILAR_LIMIT,
  MIN_HISTORY_FOR_SKIP,
  ACTION_SIMILARITY_WINDOW_MS,
} from "@cued/shared";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";

/** Type for similar action result */
interface SimilarAction {
  actionId: Id<"actions">;
  similarity: number;
  status: Doc<"actions">["status"];
}

/** Type for situation outcomes */
interface SituationOutcomes {
  dismissRate: number;
  totalActions: number;
  dismissed: number;
  completed: number;
}

/** Type for debug result */
interface DebugFindSimilarResult {
  similar: Array<{
    actionId: Id<"actions">;
    similarity: number;
    status: Doc<"actions">["status"];
    embeddingInput: string;
  }>;
  outcomes: SituationOutcomes;
  wouldSkip?: boolean;
}

/** Input message type for embedding processing */
interface EmbeddingMessage {
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

/** Conversation context for embedding */
interface EmbeddingConversationContext {
  platform: string;
  conversationType?: "dm" | "group" | "channel";
  displayName?: string;
  workspaceId?: string;
}

/** Result from processMessagesForEmbedding */
interface EmbeddingProcessResult {
  shouldSkip: boolean;
  skipReason?: string;
  triggerMessageId?: Id<"messages">;
  embedding?: number[];
  embeddingInput?: string;
}

// ============================================================================
// Internal mutations
// ============================================================================

/**
 * Store an embedding on an existing action.
 * This is atomic - no race condition since we're patching a single document.
 */
export const storeEmbedding = internalMutation({
  args: {
    actionId: v.id("actions"),
    embedding: v.array(v.float64()),
    embeddingInput: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.actionId, {
      embedding: args.embedding,
      embeddingInput: args.embeddingInput,
    });
  },
});

// ============================================================================
// Internal queries/actions
// ============================================================================

/**
 * Find similar actions using native Convex vector search.
 * Returns actions with their status for outcome calculation.
 * Uses rolling window to only consider recent actions.
 */
export const findSimilarActions = internalAction({
  args: {
    userId: v.id("users"),
    embedding: v.array(v.float64()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? SIMILAR_LIMIT;

    // Use native Convex vector search with userId filter
    const results = await ctx.vectorSearch("actions", "by_embedding", {
      vector: args.embedding,
      limit: limit * 3, // Get more to account for threshold + time filtering
      filter: (q) => q.eq("userId", args.userId),
    });

    if (results.length === 0) {
      return [];
    }

    // Filter by similarity threshold and rolling window
    const cutoffTime = Date.now() - ACTION_SIMILARITY_WINDOW_MS;
    const similarActions: SimilarAction[] = [];

    for (const result of results) {
      if (result._score < SIMILARITY_THRESHOLD) continue;
      if (similarActions.length >= limit) break;

      const action = await ctx.runQuery(internal.embeddings.getActionById, {
        actionId: result._id,
      });

      if (action && action.createdAt >= cutoffTime) {
        similarActions.push({
          actionId: action._id,
          similarity: result._score,
          status: action.status,
        });
      }
    }

    return similarActions;
  },
});

/**
 * Get action by ID (used by vector search).
 */
export const getActionById = internalQuery({
  args: { actionId: v.id("actions") },
  handler: async (ctx, args) => {
    return ctx.db.get(args.actionId);
  },
});

/**
 * Compute outcomes from similar actions.
 * Since we have the status on each action, this is simple counting.
 */
export const computeOutcomes = (actions: SimilarAction[]): SituationOutcomes => {
  if (actions.length === 0) {
    return { dismissRate: 0, totalActions: 0, dismissed: 0, completed: 0 };
  }

  let dismissed = 0;
  let completed = 0;

  for (const action of actions) {
    if (action.status === "discarded") {
      dismissed++;
    } else if (action.status === "completed") {
      completed++;
    }
    // snoozed/expired/pending don't count toward rate
  }

  const resolved = dismissed + completed;
  const dismissRate = resolved > 0 ? dismissed / resolved : 0;

  return {
    dismissRate,
    totalActions: actions.length,
    dismissed,
    completed,
  };
};

/**
 * Check if we should skip LLM for this message based on historical outcomes.
 * Returns { shouldSkip: boolean, reason?: string, dismissRate?: number }
 */
export const checkShouldSkipLlm = internalAction({
  args: {
    userId: v.id("users"),
    embedding: v.array(v.float64()),
  },
  handler: async (ctx, args) => {
    // Find similar actions using vector search
    const similar: SimilarAction[] = await ctx.runAction(
      internal.embeddings.findSimilarActions,
      {
        userId: args.userId,
        embedding: args.embedding,
        limit: SIMILAR_LIMIT,
      }
    );

    if (similar.length === 0) {
      return { shouldSkip: false, reason: "No similar actions found" };
    }

    // Compute outcomes directly from the actions
    const outcomes = computeOutcomes(similar);

    // Check against resolved outcomes (completed + discarded)
    const resolvedCount = outcomes.dismissed + outcomes.completed;
    if (resolvedCount < MIN_HISTORY_FOR_SKIP) {
      return {
        shouldSkip: false,
        reason: `Not enough resolved history (${resolvedCount} resolved of ${outcomes.totalActions} total)`,
      };
    }

    if (outcomes.dismissRate >= DISMISS_THRESHOLD) {
      return {
        shouldSkip: true,
        reason: `${Math.round(outcomes.dismissRate * 100)}% similar actions dismissed`,
        dismissRate: outcomes.dismissRate,
      };
    }

    return {
      shouldSkip: false,
      reason: `Dismiss rate ${Math.round(outcomes.dismissRate * 100)}% below threshold`,
      dismissRate: outcomes.dismissRate,
    };
  },
});

/**
 * Process messages for embedding: find trigger, compute embedding, check if should skip.
 * Returns everything needed to decide skip AND to store the embedding later.
 */
export const processMessagesForEmbedding = internalAction({
  args: {
    userId: v.id("users"),
    messages: v.array(
      v.object({
        _id: v.id("messages"),
        content: v.string(),
        isFromMe: v.boolean(),
        sentAt: v.number(),
        senderName: v.optional(v.string()),
        reactions: v.optional(
          v.array(
            v.object({
              emoji: v.string(),
              isFromMe: v.boolean(),
              timestamp: v.number(),
              reactorName: v.optional(v.string()),
            })
          )
        ),
      })
    ),
    conversation: v.object({
      platform: v.string(),
      conversationType: v.optional(
        v.union(v.literal("dm"), v.literal("group"), v.literal("channel"))
      ),
      displayName: v.optional(v.string()),
      workspaceId: v.optional(v.string()),
    }),
    contactName: v.string(),
    participantNames: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<EmbeddingProcessResult> => {
    // Find the trigger message (last message from contact, not from user)
    const messages = args.messages as EmbeddingMessage[];
    const triggerMessage = [...messages].reverse().find((m) => !m.isFromMe);

    if (!triggerMessage) {
      return { shouldSkip: false };
    }

    // Build context messages (messages before the trigger, in chronological order)
    const contextMessages = messages
      .filter((m) => m.sentAt < triggerMessage.sentAt)
      .sort((a, b) => a.sentAt - b.sentAt)
      .map((m) => ({
        content: m.content,
        isFromMe: m.isFromMe,
        senderName: m.senderName,
        reactions: m.reactions,
      }));

    // Import embedding helpers
    const { buildEmbeddingInput, embedText } = await import("@cued/ai");

    // Build embedding input
    const embeddingInput = buildEmbeddingInput(
      {
        content: triggerMessage.content,
        senderName: triggerMessage.senderName,
        reactions: triggerMessage.reactions,
      },
      contextMessages,
      args.conversation.platform,
      args.contactName,
      {
        conversationType: args.conversation.conversationType,
        conversationName: args.conversation.displayName,
        participantNames: args.participantNames,
        workspaceName: args.conversation.workspaceId,
      }
    );

    // Generate embedding
    const embedding = await embedText(embeddingInput);

    // Check if similar actions were historically dismissed
    const skipCheck = await ctx.runAction(internal.embeddings.checkShouldSkipLlm, {
      userId: args.userId,
      embedding,
    });

    if (skipCheck.shouldSkip) {
      return {
        shouldSkip: true,
        skipReason: skipCheck.reason ?? "similar_dismissed",
        triggerMessageId: triggerMessage._id,
        embedding,
        embeddingInput,
      };
    }

    return {
      shouldSkip: false,
      triggerMessageId: triggerMessage._id,
      embedding,
      embeddingInput,
    };
  },
});

// ============================================================================
// Debug queries (for testing)
// ============================================================================

/**
 * Debug: Get embedding stats for a user.
 */
export const getEmbeddingStats = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const actions = await ctx.db
      .query("actions")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();

    const withEmbedding = actions.filter((a) => a.embedding !== undefined);

    return {
      totalActions: actions.length,
      actionsWithEmbedding: withEmbedding.length,
      oldestEmbeddingAt: withEmbedding.length > 0
        ? Math.min(...withEmbedding.map((a) => a.createdAt))
        : null,
      newestEmbeddingAt: withEmbedding.length > 0
        ? Math.max(...withEmbedding.map((a) => a.createdAt))
        : null,
    };
  },
});

/**
 * Debug: Find similar actions for a given text input.
 * Returns similar actions with their outcomes.
 */
export const debugFindSimilar = internalAction({
  args: {
    userId: v.id("users"),
    testInput: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<DebugFindSimilarResult> => {
    const { embedText } = await import("@cued/ai");

    // Embed the test input
    const embedding = await embedText(args.testInput);

    // Find similar actions
    const similar: SimilarAction[] = await ctx.runAction(
      internal.embeddings.findSimilarActions,
      {
        userId: args.userId,
        embedding,
        limit: args.limit ?? 10,
      }
    );

    if (similar.length === 0) {
      return {
        similar: [],
        outcomes: { dismissRate: 0, totalActions: 0, dismissed: 0, completed: 0 },
      };
    }

    // Get the actual embedding input for each similar action
    const enriched = await Promise.all(
      similar.map(async (s) => {
        const action = await ctx.runQuery(internal.embeddings.getActionById, {
          actionId: s.actionId,
        });
        return {
          actionId: s.actionId,
          similarity: Math.round(s.similarity * 100) / 100,
          status: s.status,
          embeddingInput: (action?.embeddingInput?.slice(0, 200) ?? "") + "...",
        };
      })
    );

    const outcomes = computeOutcomes(similar);
    const resolvedCount = outcomes.dismissed + outcomes.completed;

    return {
      similar: enriched,
      outcomes,
      wouldSkip:
        resolvedCount >= MIN_HISTORY_FOR_SKIP &&
        outcomes.dismissRate >= DISMISS_THRESHOLD,
    };
  },
});
