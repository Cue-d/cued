import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { getAuthenticatedUser, requireAuthenticatedUser } from "./lib/auth";
import { actionStatusValidator, actionTypeValidator } from "./schema";

/** Enrich an action with related contact and conversation data. */
async function enrichAction(
  ctx: QueryCtx,
  action: Doc<"actions">
): Promise<{
  _id: Id<"actions">;
  type: Doc<"actions">["type"];
  status: Doc<"actions">["status"];
  priority: number;
  draftMessage: string | null;
  reason: string | null;
  createdAt: number;
  completedAt: number | null;
  snoozedUntil: number | null;
  conversationId: Id<"conversations"> | null;
  contactId: Id<"contacts"> | null;
  contactName: string | null;
  platform: string | null;
}> {
  const [conversation, contact] = await Promise.all([
    action.conversationId ? ctx.db.get(action.conversationId) : null,
    action.contactId ? ctx.db.get(action.contactId) : null,
  ]);

  return {
    _id: action._id,
    type: action.type,
    status: action.status,
    priority: action.priority,
    draftMessage: action.draftMessage ?? null,
    reason: action.reason ?? null,
    createdAt: action.createdAt,
    completedAt: action.completedAt ?? null,
    snoozedUntil: action.snoozedUntil ?? null,
    conversationId: action.conversationId ?? null,
    contactId: action.contactId ?? null,
    contactName: contact?.displayName ?? null,
    platform: conversation?.platform ?? null,
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
    draftMessage: v.optional(v.string()),
    reason: v.optional(v.string()),
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
      draftMessage: args.draftMessage,
      reason: args.reason,
      createdAt: Date.now(),
    });

    return { actionId };
  },
});

/**
 * Get pending actions for the current user.
 */
export const getPendingActions = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return { actions: [] };

    const limit = Math.min(args.limit ?? 20, 100);

    const actions = await ctx.db
      .query("actions")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", user._id).eq("status", "pending")
      )
      .take(limit);

    const enriched = await Promise.all(
      actions.map((a) => enrichAction(ctx, a))
    );
    return { actions: enriched };
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

    const updates: Partial<Doc<"actions">> = {
      status: args.status,
    };

    if (args.status === "completed") {
      updates.completedAt = Date.now();
    }

    if (args.status === "snoozed" && args.snoozedUntil) {
      updates.snoozedUntil = args.snoozedUntil;
    }

    await ctx.db.patch(args.actionId, updates);

    return { success: true };
  },
});
