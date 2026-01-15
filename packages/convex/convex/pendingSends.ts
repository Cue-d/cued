/**
 * Pending sends management for iMessage via Electron.
 * Electron polls getPendingSends, executes AppleScript, then updates status.
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthenticatedUser } from "./lib/auth";

/**
 * Get pending sends for the current user.
 * Called by Electron app to poll for messages to send.
 */
export const getPendingSends = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return { sends: [] };

    const limit = Math.min(args.limit ?? 10, 50);

    const sends = await ctx.db
      .query("pendingSends")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", user._id).eq("status", "pending")
      )
      .take(limit);

    return { sends };
  },
});

/**
 * Create a pending send for iMessage.
 * Called from swipeAction when completing an iMessage action.
 */
export const createPendingSend = mutation({
  args: {
    conversationId: v.id("conversations"),
    actionId: v.optional(v.id("actions")),
    text: v.string(),
    recipientHandle: v.string(),
    isGroup: v.boolean(),
    chatIdentifier: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const sendId = await ctx.db.insert("pendingSends", {
      userId: user._id,
      conversationId: args.conversationId,
      actionId: args.actionId,
      text: args.text,
      recipientHandle: args.recipientHandle,
      isGroup: args.isGroup,
      chatIdentifier: args.chatIdentifier,
      status: "pending",
      createdAt: Date.now(),
      attempts: 0,
    });

    return { sendId };
  },
});

/**
 * Mark a pending send as "sending" (in progress).
 * Called by Electron before attempting to send.
 */
export const markSending = mutation({
  args: {
    sendId: v.id("pendingSends"),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const send = await ctx.db.get(args.sendId);
    if (!send || send.userId !== user._id) {
      throw new Error("Pending send not found");
    }

    await ctx.db.patch(args.sendId, {
      status: "sending",
      attempts: send.attempts + 1,
      lastAttemptAt: Date.now(),
    });

    return { success: true };
  },
});

/**
 * Mark a pending send as "sent" (success).
 * Called by Electron after AppleScript succeeds.
 */
export const markSent = mutation({
  args: {
    sendId: v.id("pendingSends"),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const send = await ctx.db.get(args.sendId);
    if (!send || send.userId !== user._id) {
      throw new Error("Pending send not found");
    }

    await ctx.db.patch(args.sendId, {
      status: "sent",
      sentAt: Date.now(),
    });

    return { success: true };
  },
});

/**
 * Mark a pending send as "failed".
 * Called by Electron when AppleScript fails.
 */
export const markFailed = mutation({
  args: {
    sendId: v.id("pendingSends"),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const send = await ctx.db.get(args.sendId);
    if (!send || send.userId !== user._id) {
      throw new Error("Pending send not found");
    }

    // After 3 attempts, mark as permanently failed
    const newStatus = send.attempts >= 3 ? "failed" : "pending";

    await ctx.db.patch(args.sendId, {
      status: newStatus,
      error: args.error,
    });

    return { success: true, willRetry: newStatus === "pending" };
  },
});

/**
 * Test sending an iMessage directly (for testing).
 * Creates a pending send without requiring a conversation.
 */
export const testSendMessage = mutation({
  args: {
    recipientHandle: v.string(), // Phone number or email
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const sendId = await ctx.db.insert("pendingSends", {
      userId: user._id,
      text: args.text,
      recipientHandle: args.recipientHandle,
      isGroup: false,
      status: "pending",
      createdAt: Date.now(),
      attempts: 0,
    });

    return { sendId, message: `Queued message to ${args.recipientHandle}` };
  },
});

/**
 * Retry a failed send.
 * Resets status to pending for another attempt.
 */
export const retrySend = mutation({
  args: {
    sendId: v.id("pendingSends"),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const send = await ctx.db.get(args.sendId);
    if (!send || send.userId !== user._id) {
      throw new Error("Pending send not found");
    }

    if (send.status !== "failed") {
      throw new Error("Can only retry failed sends");
    }

    await ctx.db.patch(args.sendId, {
      status: "pending",
      error: undefined,
      attempts: 0,
    });

    return { success: true };
  },
});
