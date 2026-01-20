/**
 * Unified message queue for multi-platform sending.
 * Replaces platform-specific pendingSends with a single queue supporting all platforms.
 */
import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthenticatedUser } from "./lib/auth";
import { platformValidator } from "./schema";

/** Default undo window in seconds (used when user has no preference) */
const DEFAULT_UNDO_DELAY_SECONDS = 30;

/** Valid undo delay options in seconds */
export const UNDO_DELAY_OPTIONS = [3, 5, 10, 15, 30] as const;

/** Maximum retry attempts before marking as failed */
const MAX_ATTEMPTS = 3;

/**
 * Internal mutation called by scheduler when undo window expires.
 * Touches the message to trigger subscription updates for reactive clients.
 */
export const markReady = internalMutation({
  args: { messageId: v.id("messageQueue") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);

    // Only mark as ready if still pending
    if (!message || message.status !== "pending") {
      return;
    }

    // Update scheduledFor to trigger subscription updates
    // The write operation notifies reactive clients even if value is similar
    await ctx.db.patch(args.messageId, {
      scheduledFor: Date.now(),
    });
  },
});

/**
 * Get messages ready to be sent by Electron.
 * Returns messages where scheduledFor < now && status === "pending".
 * This implements the undo window - messages wait 30s before becoming sendable.
 */
export const getQueuedMessages = query({
  args: {
    limit: v.optional(v.number()),
    platform: v.optional(platformValidator),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return { messages: [] };

    const limit = Math.min(args.limit ?? 10, 50);
    const now = Date.now();

    // Get pending messages that are past their scheduled time
    let messagesQuery = ctx.db
      .query("messageQueue")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", user._id).eq("status", "pending")
      );

    const allMessages = await messagesQuery.collect();

    // Filter by scheduledFor < now and optionally by platform
    let filteredMessages = allMessages.filter((m) => m.scheduledFor <= now);

    if (args.platform) {
      filteredMessages = filteredMessages.filter(
        (m) => m.platform === args.platform
      );
    }

    // Sort by scheduledFor (oldest first) and take limit
    const messages = filteredMessages
      .sort((a, b) => a.scheduledFor - b.scheduledFor)
      .slice(0, limit);

    return { messages };
  },
});

/**
 * Get pending messages for the current user (for UI display).
 * Returns messages that are still in the undo window (status === "pending" && scheduledFor > now).
 * Used by UndoSendToast and message queue status dashboard.
 */
export const getPendingMessages = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return { messages: [] };

    const limit = Math.min(args.limit ?? 20, 100);
    const now = Date.now();

    // Get pending messages using the scheduledFor index
    const allPending = await ctx.db
      .query("messageQueue")
      .withIndex("by_user_pending", (q) => q.eq("userId", user._id))
      .collect();

    // Filter to only pending status messages that are still in undo window
    const pendingInUndoWindow = allPending
      .filter((m) => m.status === "pending" && m.scheduledFor > now)
      .sort((a, b) => a.scheduledFor - b.scheduledFor)
      .slice(0, limit);

    // Calculate time remaining for each message
    const messages = pendingInUndoWindow.map((m) => ({
      ...m,
      timeRemainingMs: Math.max(0, m.scheduledFor - now),
    }));

    return { messages };
  },
});

/**
 * Get message queue statistics for the current user.
 * Returns counts by status for dashboard/debugging.
 */
export const getMessageQueueStats = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthenticatedUser(ctx);
    const emptyStats = { pending: 0, sending: 0, sent: 0, failed: 0, cancelled: 0, total: 0 };
    if (!user) return emptyStats;

    const allMessages = await ctx.db
      .query("messageQueue")
      .withIndex("by_user_status", (q) => q.eq("userId", user._id))
      .collect();

    const stats = { ...emptyStats, total: allMessages.length };
    for (const message of allMessages) {
      const status = message.status as keyof Omit<typeof stats, "total">;
      if (status in stats) {
        stats[status]++;
      }
    }

    return stats;
  },
});

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Queue a message for sending.
 * Message will be scheduled based on user's undoSendDelaySeconds setting.
 */
export const queueMessage = mutation({
  args: {
    platform: platformValidator,
    recipientHandle: v.string(),
    recipientContactId: v.optional(v.id("contacts")),
    text: v.string(),
    isGroup: v.boolean(),
    chatIdentifier: v.optional(v.string()),
    conversationId: v.optional(v.id("conversations")),
    actionId: v.optional(v.id("actions")),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const now = Date.now();
    const delaySeconds = user.undoSendDelaySeconds ?? DEFAULT_UNDO_DELAY_SECONDS;
    const scheduledFor = now + delaySeconds * 1000;

    const messageId = await ctx.db.insert("messageQueue", {
      userId: user._id,
      platform: args.platform,
      recipientHandle: args.recipientHandle,
      recipientContactId: args.recipientContactId,
      text: args.text,
      isGroup: args.isGroup,
      chatIdentifier: args.chatIdentifier,
      conversationId: args.conversationId,
      actionId: args.actionId,
      status: "pending",
      scheduledFor,
      attempts: 0,
      createdAt: now,
    });

    // Schedule markReady to run when undo window expires.
    // This triggers a data change that notifies reactive clients.
    await ctx.scheduler.runAt(scheduledFor, internal.messageQueue.markReady, {
      messageId,
    });

    return { messageId, scheduledFor };
  },
});

/**
 * Cancel a pending message (undo send).
 * Only works if message is still pending and within undo window.
 */
export const cancelMessage = mutation({
  args: {
    messageId: v.id("messageQueue"),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const message = await ctx.db.get(args.messageId);
    if (!message || message.userId !== user._id) {
      throw new Error("Message not found");
    }

    if (message.status !== "pending") {
      throw new Error("Can only cancel pending messages");
    }

    await ctx.db.patch(args.messageId, {
      status: "cancelled",
      cancelledAt: Date.now(),
    });

    return { success: true };
  },
});

/**
 * Update message status.
 * Called by Electron after send attempt.
 */
export const updateMessageStatus = mutation({
  args: {
    messageId: v.id("messageQueue"),
    status: v.union(
      v.literal("sending"),
      v.literal("sent"),
      v.literal("failed")
    ),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const message = await ctx.db.get(args.messageId);
    if (!message || message.userId !== user._id) {
      throw new Error("Message not found");
    }

    const now = Date.now();

    switch (args.status) {
      case "sending":
        await ctx.db.patch(args.messageId, {
          status: "sending",
          attempts: message.attempts + 1,
          lastAttemptAt: now,
        });
        break;

      case "sent":
        await ctx.db.patch(args.messageId, {
          status: "sent",
          sentAt: now,
        });
        break;

      case "failed": {
        // Auto-retry if under max attempts
        const willRetry = message.attempts < MAX_ATTEMPTS;
        await ctx.db.patch(args.messageId, {
          status: willRetry ? "pending" : "failed",
          error: args.error,
          ...(willRetry && { scheduledFor: now }),
        });

        // Schedule markReady to trigger subscription update for retry
        if (willRetry) {
          await ctx.scheduler.runAt(now, internal.messageQueue.markReady, {
            messageId: args.messageId,
          });
        }

        return { success: true, willRetry };
      }
    }

    return { success: true, willRetry: false };
  },
});

/**
 * Send a pending message immediately (skip undo window).
 * Sets scheduledFor to now so message is picked up immediately.
 */
export const sendImmediately = mutation({
  args: {
    messageId: v.id("messageQueue"),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const message = await ctx.db.get(args.messageId);
    if (!message || message.userId !== user._id) {
      throw new Error("Message not found");
    }

    if (message.status !== "pending") {
      throw new Error("Can only send pending messages immediately");
    }

    await ctx.db.patch(args.messageId, {
      scheduledFor: Date.now(),
    });

    return { success: true };
  },
});

/**
 * Retry a failed message.
 * Resets status to pending and clears error.
 */
export const retryMessage = mutation({
  args: {
    messageId: v.id("messageQueue"),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const message = await ctx.db.get(args.messageId);
    if (!message || message.userId !== user._id) {
      throw new Error("Message not found");
    }

    if (message.status !== "failed") {
      throw new Error("Can only retry failed messages");
    }

    await ctx.db.patch(args.messageId, {
      status: "pending",
      error: undefined,
      attempts: 0,
      scheduledFor: Date.now(), // Schedule for immediate send
    });

    return { success: true };
  },
});
