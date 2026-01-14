import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { getAuthenticatedUser, requireAuthenticatedUser } from "./lib/auth";
import { actionStatusValidator, actionTypeValidator } from "./schema";

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
      actions.map(async (action) => {
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
          conversationId: action.conversationId ?? null,
          contactName: contact?.displayName ?? null,
          platform: conversation?.platform ?? null,
        };
      })
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
