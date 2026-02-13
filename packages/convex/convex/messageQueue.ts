/**
 * Unified message queue for multi-platform sending.
 * Replaces platform-specific pendingSends with a single queue supporting all platforms.
 */
import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { getAuthenticatedUser } from "./lib/auth";
import { insertQueuedMessage } from "./lib/queueMessageInsert";
import { platformValidator } from "./schema";

/** Maximum retry attempts before marking as failed */
const MAX_ATTEMPTS = 3;

/** Timeout threshold for the Convex safety net (2x the Electron 15s timeout) */
const STALE_SEND_THRESHOLD_MS = 30_000;

/**
 * If a message is still pending after this long and no Electron client is online,
 * mark it failed so the UI doesn't sit on an indefinite "in-flight" state.
 */
const PENDING_OFFLINE_FAIL_THRESHOLD_MS = 15_000;

/**
 * Keep in sync with presence.ts STALE_THRESHOLD_MS.
 * If last heartbeat is older than this, the desktop sender is considered offline.
 */
const ELECTRON_PRESENCE_STALE_MS = 30_000;

/** Lease duration for single-sender lock */
const CLAIM_LEASE_MS = 20_000;

/** Platforms that rely on an online Electron sender. */
const ELECTRON_MANAGED_PLATFORMS = new Set<string>([
  "imessage",
  "slack",
  "linkedin",
  "twitter",
  "signal",
  "whatsapp",
] as const);

/** Get messages ready to be sent by Electron. */
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

    const [allPendingMessages, allSendingMessages] = await Promise.all([
      ctx.db
        .query("messageQueue")
        .withIndex("by_user_status", (q) =>
          q.eq("userId", user._id).eq("status", "pending")
        )
        .collect(),
      ctx.db
        .query("messageQueue")
        .withIndex("by_user_status", (q) =>
          q.eq("userId", user._id).eq("status", "sending")
        )
        .collect(),
    ]);

    let sendingMessages = allSendingMessages;
    let readyPendingMessages = allPendingMessages.filter((m) => m.scheduledFor <= now);

    if (args.platform) {
      sendingMessages = sendingMessages.filter((m) => m.platform === args.platform);
      readyPendingMessages = readyPendingMessages.filter(
        (m) => m.platform === args.platform
      );
    }

    // Time-based queue ordering:
    // - Messages are released by scheduledFor (oldest first).
    // - Retries reset scheduledFor to now, intentionally re-ordering them as fresh attempts.
    // This mirrors platform-visible send order rather than preserving original enqueue order.
    readyPendingMessages.sort((a, b) => {
      if (a.scheduledFor !== b.scheduledFor) return a.scheduledFor - b.scheduledFor;
      return a.createdAt - b.createdAt;
    });

    // Per-conversation ordering:
    // - Never release if a message in this conversation is already sending.
    // - Only release one ready message per conversation in this batch.
    const sendingConversations = new Set<string>();
    for (const m of sendingMessages) {
      if (m.conversationId) {
        sendingConversations.add(m.conversationId);
      }
    }

    const eligible: typeof readyPendingMessages = [];
    const releasedConversations = new Set<string>();

    for (const msg of readyPendingMessages) {
      if (!msg.conversationId) {
        eligible.push(msg); // No conversation = always eligible
        continue;
      }

      const convId = msg.conversationId;

      // Skip if this conversation already has a message being sent
      if (sendingConversations.has(convId)) continue;

      // Only release one ready message per conversation per query result
      if (releasedConversations.has(convId)) continue;
      releasedConversations.add(convId);
      eligible.push(msg);
    }

    return { messages: eligible.slice(0, limit) };
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
    workspaceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const now = Date.now();
    const scheduledFor = now;
    const requiresThreadId =
      args.platform === "linkedin" || args.platform === "slack";
    let resolvedConversationId = args.conversationId;
    let resolvedChatIdentifier = args.chatIdentifier;
    let resolvedWorkspaceId = args.workspaceId;

    if (requiresThreadId && !resolvedChatIdentifier) {
      // First try explicit conversationId if provided
      if (resolvedConversationId) {
        const conversation = await ctx.db.get(resolvedConversationId);
        if (
          conversation &&
          conversation.userId === user._id &&
          conversation.platform === args.platform
        ) {
          resolvedChatIdentifier = conversation.platformConversationId;
          resolvedWorkspaceId = resolvedWorkspaceId ?? conversation.workspaceId;
        }
      }

      // Otherwise resolve from recipient contact + platform (pick most recent)
      if (!resolvedChatIdentifier && args.recipientContactId) {
        const conversations = await ctx.db
          .query("conversations")
          .withIndex("by_user_platform", (q) =>
            q.eq("userId", user._id).eq("platform", args.platform)
          )
          .collect();

        const matchedConversation = conversations
          .filter((c) => c.participantContactIds.includes(args.recipientContactId!))
          .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))[0];

        if (matchedConversation) {
          resolvedConversationId = matchedConversation._id;
          resolvedChatIdentifier = matchedConversation.platformConversationId;
          resolvedWorkspaceId = resolvedWorkspaceId ?? matchedConversation.workspaceId;
        }
      }
    }

    if (requiresThreadId && !resolvedChatIdentifier) {
      const platformLabel = args.platform === "linkedin" ? "LinkedIn" : "Slack";
      throw new Error(
        `${platformLabel} messages require an existing conversation. Open an existing ${platformLabel} thread first so we can resolve a conversation ID.`
      );
    }

    return insertQueuedMessage(ctx, {
      userId: user._id,
      platform: args.platform,
      recipientHandle: args.recipientHandle,
      recipientContactId: args.recipientContactId,
      text: args.text,
      isGroup: args.isGroup,
      chatIdentifier: resolvedChatIdentifier ?? undefined,
      conversationId: resolvedConversationId ?? undefined,
      actionId: args.actionId,
      workspaceId: resolvedWorkspaceId ?? undefined,
      now,
      scheduledFor,
    });
  },
});

/** Cancel a pending queued message before it is claimed for sending. */
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

    const now = Date.now();
    if (message.processingDeviceId) {
      const leaseAge = now - (message.processingStartedAt ?? 0);
      if (leaseAge < CLAIM_LEASE_MS) {
        throw new Error("Message is already being processed");
      }
    }

    await ctx.db.patch(args.messageId, {
      status: "cancelled",
      cancelledAt: now,
      processingDeviceId: undefined,
      processingStartedAt: undefined,
    });

    return { success: true };
  },
});

/**
 * Update message status.
 * Called by Electron after send attempt or pre-send validation failures.
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
      case "sending": {
        if (message.status !== "pending") {
          return { success: false, willRetry: false, reason: "not_pending" as const };
        }

        if (message.conversationId) {
          const conversationQueue = await ctx.db
            .query("messageQueue")
            .withIndex("by_conversation_sequence", (q) =>
              q.eq("conversationId", message.conversationId)
            )
            .collect();
          const hasActiveSender = conversationQueue.some(
            (entry) =>
              entry._id !== args.messageId &&
              entry.userId === user._id &&
              entry.status === "sending"
          );
          if (hasActiveSender) {
            return {
              success: false,
              willRetry: false,
              reason: "conversation_locked" as const,
            };
          }
        }

        await ctx.db.patch(args.messageId, {
          status: "sending",
          attempts: message.attempts + 1,
          lastAttemptAt: now,
          processingStartedAt: now,
        });
        break;
      }

      case "sent": {
        if (message.status !== "sending") {
          return { success: false, willRetry: false, reason: "not_sending" as const };
        }

        await ctx.db.patch(args.messageId, {
          status: "sent",
          sentAt: now,
          processingStartedAt: undefined,
          processingDeviceId: undefined,
        });
        break;
      }

      case "failed": {
        // Pre-send failures (e.g., adapter unavailable / unauthenticated)
        // can fail directly from pending without retrying in place.
        if (message.status === "pending") {
          await ctx.db.patch(args.messageId, {
            status: "failed",
            error: args.error,
            processingStartedAt: undefined,
            processingDeviceId: undefined,
          });
          return { success: true, willRetry: false };
        }

        if (message.status !== "sending") {
          return { success: false, willRetry: false, reason: "not_sending" as const };
        }

        // Auto-retry if under max attempts.
        // Policy: retries are treated as fresh send attempts and re-enter
        // the queue at "now", which may re-order them vs original enqueue order.
        const willRetry = message.attempts < MAX_ATTEMPTS;
        await ctx.db.patch(args.messageId, {
          status: willRetry ? "pending" : "failed",
          error: args.error,
          processingStartedAt: undefined,
          processingDeviceId: undefined,
          ...(willRetry && { scheduledFor: now }),
        });

        return { success: true, willRetry };
      }
    }

    return { success: true, willRetry: false };
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
      // Retry policy: enqueue at current time so retry order reflects
      // actual platform send timing rather than original enqueue position.
      scheduledFor: Date.now(),
    });

    return { success: true };
  },
});

// ============================================================================
// SINGLE-SENDER LOCK
// ============================================================================

/**
 * Claim a message for processing (single-sender lock).
 * Prevents multiple Electron instances from processing the same message.
 * Uses a 20s lease — if the claim expires, another device can steal it.
 */
export const claimMessage = mutation({
  args: {
    messageId: v.id("messageQueue"),
    deviceId: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const message = await ctx.db.get(args.messageId);
    if (!message || message.userId !== user._id) {
      return { success: false, reason: "not_found" as const };
    }

    if (message.status !== "pending") {
      return { success: false, reason: "not_pending" as const };
    }

    // Check if already claimed by another device with an active lease
    if (message.processingDeviceId && message.processingDeviceId !== args.deviceId) {
      const leaseAge = Date.now() - (message.processingStartedAt ?? 0);
      if (leaseAge < CLAIM_LEASE_MS) {
        return { success: false, reason: "locked" as const };
      }
      // Lease expired, steal it
    }

    await ctx.db.patch(args.messageId, {
      processingDeviceId: args.deviceId,
      processingStartedAt: Date.now(),
    });

    return { success: true, reason: "claimed" as const };
  },
});

// ============================================================================
// TIMEOUT SAFETY NET
// ============================================================================

/**
 * Convex safety net for stale queue entries.
 * Handles:
 * - "sending" rows stuck after crashes/disconnects
 * - "pending" rows that are ready but have no online Electron sender
 */
export const timeoutStaleSends = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const sendingThreshold = now - STALE_SEND_THRESHOLD_MS;
    const pendingOfflineThreshold = now - PENDING_OFFLINE_FAIL_THRESHOLD_MS;

    const [allSending, stalePending, allElectronPresence] = await Promise.all([
      // Find all messages stuck in "sending" past the threshold
      ctx.db
        .query("messageQueue")
        .withIndex("by_status", (q) => q.eq("status", "sending"))
        .collect(),
      // Find pending messages that are ready and have been waiting too long
      ctx.db
        .query("messageQueue")
        .withIndex("by_status_scheduledFor", (q) =>
          q.eq("status", "pending").lte("scheduledFor", pendingOfflineThreshold)
        )
        .collect(),
      // Current desktop presence by user
      ctx.db
        .query("devicePresence")
        .withIndex("by_device_type", (q) => q.eq("deviceType", "electron"))
        .collect(),
    ]);

    const onlineElectronUsers = new Set<string>();
    for (const presence of allElectronPresence) {
      if (now - presence.lastHeartbeatAt < ELECTRON_PRESENCE_STALE_MS) {
        onlineElectronUsers.add(presence.userId as string);
      }
    }

    const staleSends = allSending.filter(
      (m) => (m.processingStartedAt ?? m.lastAttemptAt ?? 0) < sendingThreshold
    );

    const stalePendingWithoutSender = stalePending.filter((m) => {
      if (!ELECTRON_MANAGED_PLATFORMS.has(m.platform)) return false;
      if (onlineElectronUsers.has(m.userId as string)) return false;

      // Respect active claim leases to avoid racing healthy processors.
      if (m.processingDeviceId) {
        const leaseAge = now - (m.processingStartedAt ?? 0);
        if (leaseAge < CLAIM_LEASE_MS) return false;
      }
      return true;
    });

    for (const msg of staleSends) {
      const willRetry = msg.attempts < MAX_ATTEMPTS;
      console.log(
        `[timeoutStaleSends] Message ${msg._id} stuck in sending for ${now - (msg.processingStartedAt ?? 0)}ms, ${willRetry ? "retrying" : "failing"}`
      );

      await ctx.db.patch(msg._id, {
        status: willRetry ? "pending" : "failed",
        error: "Send timed out (safety net)",
        processingStartedAt: undefined,
        processingDeviceId: undefined,
        ...(willRetry && { scheduledFor: now }),
      });
    }

    for (const msg of stalePendingWithoutSender) {
      await ctx.db.patch(msg._id, {
        status: "failed",
        error: "Desktop app is offline. Open Cued desktop to send.",
        processingStartedAt: undefined,
        processingDeviceId: undefined,
      });
    }

    if (staleSends.length > 0 || stalePendingWithoutSender.length > 0) {
      console.log(
        `[timeoutStaleSends] Recovered ${staleSends.length} stale sends and failed ${stalePendingWithoutSender.length} pending messages with no desktop sender`
      );
    }
  },
});

/**
 * Delete a failed message from the queue.
 */
export const deleteMessage = mutation({
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
      throw new Error("Can only delete failed messages");
    }

    await ctx.db.delete(args.messageId);
    return { success: true };
  },
});
