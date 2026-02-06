import { v } from "convex/values";
import type { EnrichedAction } from "@cued/shared";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { getAuthenticatedUser, requireAuthenticatedUser } from "./lib/auth";
import { adjustPendingActionCount } from "./lib/actions";
import {
  actionStatusValidator,
  actionTypeValidator,
  platformValidator,
} from "./schema";
import { executeSwipeHandler } from "./swipeHandlers/registry";

/**
 * Fetch all actionable items: pending actions + snoozed actions that are due.
 * This is the core logic for determining what needs user attention.
 */
async function fetchActionableActions(
  ctx: QueryCtx,
  userId: Id<"users">
): Promise<Doc<"actions">[]> {
  const now = Date.now();

  const [pendingActions, snoozedActions] = await Promise.all([
    ctx.db
      .query("actions")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", userId).eq("status", "pending")
      )
      .collect(),
    ctx.db
      .query("actions")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", userId).eq("status", "snoozed")
      )
      .collect(),
  ]);

  const dueSnoozedActions = snoozedActions.filter(
    (a) => a.snoozedUntil && a.snoozedUntil <= now
  );

  return [...pendingActions, ...dueSnoozedActions];
}

/** Enrich an action with related contact and conversation data. */
async function enrichAction(
  ctx: QueryCtx,
  action: Doc<"actions">
): Promise<EnrichedAction> {
  const [conversation, contact, secondaryContact] = await Promise.all([
    action.conversationId ? ctx.db.get(action.conversationId) : null,
    action.contactId ? ctx.db.get(action.contactId) : null,
    action.secondaryContactId ? ctx.db.get(action.secondaryContactId) : null,
  ]);

  // Prefer action.platform if set, otherwise derive from conversation
  const platform = action.platform ?? conversation?.platform ?? null;

  // Determine contact name - for groups, use displayName or list participants
  let contactName: string | null = null;
  const isGroup =
    conversation?.conversationType === "group" ||
    conversation?.conversationType === "channel";

  if (isGroup) {
    if (conversation.displayName) {
      contactName = conversation.displayName;
    } else if (conversation.participantContactIds.length) {
      // Fetch participant names for group chats without displayName
      const participants = await Promise.all(
        conversation.participantContactIds.map((id) => ctx.db.get(id))
      );
      const names = participants
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .map((p) => p.displayName)
        .filter(Boolean);
      contactName = names.length > 0 ? names.join(", ") : null;
    }
  }
  // Fall back to contact name for DMs or if group name resolution failed
  if (!contactName) {
    contactName = contact?.displayName ?? null;
  }

  return {
    _id: action._id,
    type: action.type,
    status: action.status,
    priority: action.priority,
    reason: action.reason ?? null,
    llmReason: action.llmReason ?? null,
    createdAt: action.createdAt,
    snoozedUntil: action.snoozedUntil ?? null,
    completedAt: action.completedAt ?? null,
    discardedAt: action.discardedAt ?? null,
    conversationId: action.conversationId ?? null,
    contactId: action.contactId ?? null,
    contactName,
    secondaryContactId: action.secondaryContactId ?? null,
    secondaryContactName: secondaryContact?.displayName ?? null,
    mergeSuggestionId: action.mergeSuggestionId ?? null,
    mergeConfidence: action.mergeConfidence ?? null,
    mergeSource: action.mergeSource ?? null,
    mergeReasoning: action.mergeReasoning ?? null,
    platform,
  };
}

/**
 * Search actions with filters.
 * Supports filtering by status, type, contactId, conversationId, and date ranges.
 */
export const searchActions = query({
  args: {
    status: v.optional(actionStatusValidator),
    type: v.optional(actionTypeValidator),
    contactId: v.optional(v.id("contacts")),
    conversationId: v.optional(v.id("conversations")),
    createdAfter: v.optional(v.number()), // timestamp in ms
    snoozedUntilBefore: v.optional(v.number()), // timestamp in ms (for finding due snoozed items)
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return { actions: [] };

    const limit = Math.min(args.limit ?? 20, 100);

    // Start with user-filtered query
    let query = ctx.db
      .query("actions")
      .withIndex("by_user", (q) => q.eq("userId", user._id));

    // If filtering by status, use the compound index for efficiency
    if (args.status) {
      query = ctx.db
        .query("actions")
        .withIndex("by_user_status", (q) =>
          q.eq("userId", user._id).eq("status", args.status!)
        );
    }

    // Fetch all matching records and apply remaining filters in-memory
    // (Convex doesn't support multi-field filtering on non-compound indexes)
    const allActions = await query.collect();

    let filtered = allActions;

    if (args.type) {
      filtered = filtered.filter((a) => a.type === args.type);
    }

    if (args.contactId) {
      filtered = filtered.filter((a) => a.contactId === args.contactId);
    }

    if (args.conversationId) {
      filtered = filtered.filter(
        (a) => a.conversationId === args.conversationId
      );
    }

    if (args.createdAfter) {
      filtered = filtered.filter((a) => a.createdAt >= args.createdAfter!);
    }

    if (args.snoozedUntilBefore) {
      filtered = filtered.filter(
        (a) =>
          a.status === "snoozed" &&
          a.snoozedUntil &&
          a.snoozedUntil <= args.snoozedUntilBefore!
      );
    }

    // Sort by createdAt descending (most recent first)
    filtered.sort((a, b) => b.createdAt - a.createdAt);

    // Apply limit
    const actions = filtered.slice(0, limit);

    const enriched = await Promise.all(
      actions.map((a) => enrichAction(ctx, a))
    );
    return { actions: enriched };
  },
});

/**
 * Create a new action item.
 */
export const createAction = mutation({
  args: {
    type: actionTypeValidator,
    priority: v.optional(v.number()),
    conversationId: v.optional(v.id("conversations")),
    contactId: v.optional(v.id("contacts")),
    messageId: v.optional(v.id("messages")),
    platform: v.optional(platformValidator),
    reason: v.optional(v.string()),
    llmReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireAuthenticatedUser(ctx);

    const actionId = await ctx.db.insert("actions", {
      userId: user._id,
      type: args.type,
      status: "pending",
      priority: args.priority ?? 50,
      conversationId: args.conversationId,
      contactId: args.contactId,
      messageId: args.messageId,
      platform: args.platform,
      reason: args.reason,
      llmReason: args.llmReason,
      createdAt: Date.now(),
    });

    // Increment pending action count (new actions are always pending)
    await adjustPendingActionCount(ctx, user._id, 1);

    return { actionId };
  },
});

/**
 * Get pending actions for the current user.
 * Includes:
 *  - Actions with status="pending"
 *  - Snoozed actions where snoozedUntil <= now (due to wake up)
 * Supports cursor-based pagination using createdAt timestamp.
 */
export const getPendingActions = query({
  args: {
    limit: v.optional(v.number()),
    cursor: v.optional(v.number()), // createdAt timestamp of last action
    type: v.optional(actionTypeValidator), // Filter by action type
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return { actions: [], nextCursor: null };

    const limit = Math.min(args.limit ?? 20, 100);

    let actionable = await fetchActionableActions(ctx, user._id);

    // Filter by type if provided
    if (args.type) {
      actionable = actionable.filter((a) => a.type === args.type);
    }

    // Sort by priority DESC, then createdAt DESC
    actionable.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.createdAt - a.createdAt;
    });

    // Apply cursor-based pagination
    let filtered = actionable;
    if (args.cursor) {
      const cursorIdx = filtered.findIndex((a) => a.createdAt < args.cursor!);
      filtered = cursorIdx >= 0 ? filtered.slice(cursorIdx) : [];
    }

    // Take limit + 1 to determine if there's more
    const page = filtered.slice(0, limit + 1);
    const hasMore = page.length > limit;
    const actions = hasMore ? page.slice(0, limit) : page;

    const enriched = await Promise.all(
      actions.map((a) => enrichAction(ctx, a))
    );

    const nextCursor =
      hasMore && actions.length > 0
        ? actions[actions.length - 1].createdAt
        : null;

    return { actions: enriched, nextCursor };
  },
});

/**
 * Update action status (complete, discard, snooze).
 */
export const updateActionStatus = mutation({
  args: {
    actionId: v.id("actions"),
    status: actionStatusValidator,
    snoozedUntil: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await requireAuthenticatedUser(ctx);

    const action = await ctx.db.get(args.actionId);
    if (!action || action.userId !== user._id) {
      throw new Error("Action not found");
    }

    const oldStatus = action.status;
    const newStatus = args.status;

    const updates: Partial<Doc<"actions">> = {
      status: args.status,
    };

    const now = Date.now();

    if (args.status === "completed") {
      updates.completedAt = now;
    }

    if (args.status === "discarded") {
      updates.discardedAt = now;
    }

    if (args.status === "snoozed" && args.snoozedUntil) {
      updates.snoozedUntil = args.snoozedUntil;
    }

    await ctx.db.patch(args.actionId, updates);

    // Adjust pending action count based on status change
    if (oldStatus === "pending" && newStatus !== "pending") {
      await adjustPendingActionCount(ctx, user._id, -1);
    } else if (oldStatus !== "pending" && newStatus === "pending") {
      await adjustPendingActionCount(ctx, user._id, 1);
    }

    return { success: true };
  },
});

/**
 * Get a single action with full context: messages and contact info.
 * Used for the action detail view / card.
 */
export const getActionWithContext = query({
  args: {
    actionId: v.id("actions"),
    messageLimit: v.optional(v.number()), // How many messages to include (default 10)
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return null;

    const action = await ctx.db.get(args.actionId);
    if (!action || action.userId !== user._id) {
      return null;
    }

    const messageLimit = Math.min(args.messageLimit ?? 10, 50);

    // Get related conversation if exists
    const conversation = action.conversationId
      ? await ctx.db.get(action.conversationId)
      : null;

    // Get related contact if exists
    const contact = action.contactId
      ? await ctx.db.get(action.contactId)
      : null;

    // Get contact handles if we have a contact
    const handles = contact
      ? await ctx.db
          .query("contactHandles")
          .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
          .collect()
      : [];

    const secondaryContact = action.secondaryContactId
      ? await ctx.db.get(action.secondaryContactId)
      : null;

    const secondaryHandles = secondaryContact
      ? await ctx.db
          .query("contactHandles")
          .withIndex("by_contact", (q) => q.eq("contactId", secondaryContact._id))
          .collect()
      : [];

    // Get recent messages from the conversation
    const messages = action.conversationId
      ? await ctx.db
          .query("messages")
          .withIndex("by_conversation", (q) =>
            q.eq("conversationId", action.conversationId!)
          )
          .order("desc")
          .take(messageLimit)
      : [];

    // Resolve sender names for messages
    const messagesWithSender = await Promise.all(
      messages.map(async (msg) => {
        let senderName: string | null = null;
        if (msg.isFromMe) {
          senderName = "You";
        } else if (msg.senderContactId) {
          const sender = await ctx.db.get(msg.senderContactId);
          senderName = sender?.displayName ?? null;
        }

        return {
          _id: msg._id,
          content: msg.content,
          sentAt: msg.sentAt,
          isFromMe: msg.isFromMe,
          senderName,
          status: msg.status,
          reactions: msg.reactions,
        };
      })
    );

    // Reverse to show oldest first (chronological order for display)
    messagesWithSender.reverse();

    return {
      action: {
        _id: action._id,
        type: action.type,
        status: action.status,
        priority: action.priority,
        reason: action.reason ?? null,
        llmReason: action.llmReason ?? null,
        createdAt: action.createdAt,
        snoozedUntil: action.snoozedUntil ?? null,
        completedAt: action.completedAt ?? null,
        discardedAt: action.discardedAt ?? null,
        platform: action.platform ?? conversation?.platform ?? null,
        secondaryContactId: action.secondaryContactId ?? null,
        mergeSuggestionId: action.mergeSuggestionId ?? null,
      },
      conversation: conversation
        ? {
            _id: conversation._id,
            platform: conversation.platform,
            platformConversationId: conversation.platformConversationId,
            conversationType: conversation.conversationType,
            displayName: conversation.displayName ?? null,
            lastMessageAt: conversation.lastMessageAt ?? null,
            workspaceId: conversation.workspaceId ?? null,
          }
        : null,
      contact: contact
        ? {
            _id: contact._id,
            displayName: contact.displayName,
            company: contact.company ?? null,
            notes: contact.notes ?? null,
            importance: contact.importance ?? null,
            handles: handles.map((h) => ({
              handleType: h.handleType,
              handle: h.handle,
              platform: h.platform,
            })),
          }
        : null,
      secondaryContact: secondaryContact
        ? {
            _id: secondaryContact._id,
            displayName: secondaryContact.displayName,
            company: secondaryContact.company ?? null,
            notes: secondaryContact.notes ?? null,
            importance: secondaryContact.importance ?? null,
            handles: secondaryHandles.map((h) => ({
              handleType: h.handleType,
              handle: h.handle,
              platform: h.platform,
            })),
          }
        : null,
      messages: messagesWithSender,
    };
  },
});

/**
 * Get count of pending actions for sidebar badge.
 * Uses denormalized counter on users table (no expensive queries).
 */
export const getPendingActionCount = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return { count: 0 };

    return { count: user.pendingActionCount ?? 0 };
  },
});

/**
 * Get counts of pending actions grouped by type.
 * Used for filter badges in action queue UI.
 */
export const getActionCountsByType = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return { counts: {}, total: 0 };

    const actionable = await fetchActionableActions(ctx, user._id);

    // Group by type
    const counts: Record<string, number> = {};
    for (const action of actionable) {
      counts[action.type] = (counts[action.type] ?? 0) + 1;
    }

    return { counts, total: actionable.length };
  },
});

/**
 * Swipe direction type for action gestures.
 */
const swipeDirectionValidator = v.union(
  v.literal("left"), // discard
  v.literal("right"), // complete/send
  v.literal("up") // snooze
);

/**
 * Handle swipe action with platform routing.
 * Uses the action handler registry to dispatch to the appropriate handler.
 * - left: discard action
 * - right: complete/send message
 * - up: snooze action until specified time
 */
export const swipeAction = mutation({
  args: {
    actionId: v.id("actions"),
    direction: swipeDirectionValidator,
    snoozedUntil: v.optional(v.number()), // Required for direction='up'
    responseText: v.optional(v.string()), // Optional response text for direction='right'
  },
  handler: async (ctx, args) => {
    const user = await requireAuthenticatedUser(ctx);
    const now = Date.now();

    const action = await ctx.db.get(args.actionId);
    if (!action || action.userId !== user._id) {
      throw new Error("Action not found");
    }

    const wasPending = action.status === "pending";

    // Execute the handler for this action type
    const result = await executeSwipeHandler(
      action.type,
      args.direction,
      { ctx, user, action, now },
      { responseText: args.responseText, snoozedUntil: args.snoozedUntil }
    );

    // Update action status based on handler result
    const updates: Partial<Doc<"actions">> = { status: result.status };
    if (result.status === "completed") {
      updates.completedAt = now;
    } else if (result.status === "discarded") {
      updates.discardedAt = now;
    } else if (result.status === "snoozed" && args.snoozedUntil) {
      updates.snoozedUntil = args.snoozedUntil;
    }
    await ctx.db.patch(args.actionId, updates);

    // Adjust pending action count if was pending (handlers always return non-pending status)
    if (wasPending) {
      await adjustPendingActionCount(ctx, user._id, -1);
    }

    // Build return with explicit optional fields for TypeScript
    const response: {
      success: boolean;
      status: "completed" | "discarded" | "snoozed";
      queuedMessageId?: string;
      [key: string]: unknown;
    } = {
      success: result.success,
      status: result.status,
      ...result.data,
    };

    return response;
  },
});
