import { action, internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { platformValidator } from "./schema";
import { getAuthenticatedUser } from "./lib/auth";

// ============================================================================
// Debug Queries for Slack Sync
// ============================================================================

/**
 * Get Slack sync status for current user.
 * Shows conversations, messages, and cursor state.
 */
export const getSlackSyncStatus = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return null;

    // Get Slack conversations
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", user._id).eq("platform", "slack")
      )
      .collect();

    // Get sync cursors for Slack
    const cursors = await ctx.db
      .query("syncCursors")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", user._id).eq("platform", "slack")
      )
      .collect();

    // Get message counts per conversation
    const messagesByConvo = new Map<string, number>();
    for (const convo of conversations) {
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", convo._id))
        .take(100);
      messagesByConvo.set(convo._id, messages.length);
    }

    // Total messages (sample)
    const sampleMessages = await ctx.db
      .query("messages")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(5000);
    const slackMessages = sampleMessages.filter((m) => m.platform === "slack");

    return {
      totalConversations: conversations.length,
      totalMessages: slackMessages.length,
      cursors: cursors.map((c) => ({
        workspaceId: c.workspaceId,
        lastSyncAt: c.lastSyncAt,
        syncMode: c.syncMode,
        cursorData: c.cursorData,
      })),
      conversationDetails: conversations.slice(0, 20).map((c) => ({
        id: c._id,
        platformConversationId: c.platformConversationId,
        displayName: c.displayName,
        conversationType: c.conversationType,
        userParticipated: c.userParticipated, // Critical for inbox filtering
        lastMessageAt: c.lastMessageAt,
        lastMessageText: c.lastMessageText?.slice(0, 50),
        messageCount: messagesByConvo.get(c._id) ?? 0,
        participantCount: c.participantContactIds.length,
      })),
    };
  },
});

/**
 * Get messages for a specific Slack conversation.
 */
export const getSlackConversationMessages = query({
  args: {
    conversationId: v.id("conversations"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return null;

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId)
      )
      .order("desc")
      .take(args.limit ?? 20);

    return messages.map((m) => ({
      id: m._id,
      content: m.content?.slice(0, 100),
      sentAt: m.sentAt,
      isFromMe: m.isFromMe,
      platformMessageId: m.platformMessageId,
      senderContactId: m.senderContactId,
    }));
  },
});

// Larger batch for messages since there are many
const MESSAGE_BATCH_SIZE = 2000;
const DEFAULT_BATCH_SIZE = 500;

type Platform = "imessage" | "gmail" | "slack" | "linkedin" | "twitter" | "signal" | "whatsapp";

/**
 * Internal mutation to delete a batch of platform-filtered documents.
 */
export const deleteBatchFiltered = internalMutation({
  args: {
    userId: v.id("users"),
    table: v.string(),
    platforms: v.optional(v.array(platformValidator)),
  },
  handler: async (ctx, args) => {
    const { userId, table, platforms } = args;
    const batchSize = table === "messages" ? MESSAGE_BATCH_SIZE : DEFAULT_BATCH_SIZE;
    const filterByPlatform = platforms && platforms.length > 0;

    let deleted = 0;

    switch (table) {
      case "messages": {
        const docs = await ctx.db
          .query("messages")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .take(batchSize * 2); // Fetch more to account for filtering
        for (const doc of docs) {
          if (!filterByPlatform || platforms!.includes(doc.platform as Platform)) {
            await ctx.db.delete(doc._id);
            deleted++;
            if (deleted >= batchSize) break;
          }
        }
        // Continue if: full page fetched (more docs might exist) OR hit deletion limit (didn't scan all fetched docs)
        const hasMore = docs.length === batchSize * 2 || deleted >= batchSize;
        return { deleted, hasMore };
      }

      case "conversations": {
        const docs = await ctx.db
          .query("conversations")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .take(batchSize * 2);
        for (const doc of docs) {
          if (!filterByPlatform || platforms!.includes(doc.platform as Platform)) {
            await ctx.db.delete(doc._id);
            deleted++;
            if (deleted >= batchSize) break;
          }
        }
        // Continue if: full page fetched (more docs might exist) OR hit deletion limit (didn't scan all fetched docs)
        const hasMore = docs.length === batchSize * 2 || deleted >= batchSize;
        return { deleted, hasMore };
      }

      case "contactHandles": {
        const docs = await ctx.db
          .query("contactHandles")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .take(batchSize * 2);
        for (const doc of docs) {
          if (!filterByPlatform || platforms!.includes(doc.platform as Platform)) {
            await ctx.db.delete(doc._id);
            deleted++;
            if (deleted >= batchSize) break;
          }
        }
        // Continue if: full page fetched (more docs might exist) OR hit deletion limit (didn't scan all fetched docs)
        const hasMore = docs.length === batchSize * 2 || deleted >= batchSize;
        return { deleted, hasMore };
      }

      case "syncCursors": {
        const docs = await ctx.db
          .query("syncCursors")
          .withIndex("by_user_platform", (q) => q.eq("userId", userId))
          .take(batchSize * 2);
        for (const doc of docs) {
          if (!filterByPlatform || platforms!.includes(doc.platform as Platform)) {
            await ctx.db.delete(doc._id);
            deleted++;
            if (deleted >= batchSize) break;
          }
        }
        // Continue if: full page fetched (more docs might exist) OR hit deletion limit (didn't scan all fetched docs)
        const hasMore = docs.length === batchSize * 2 || deleted >= batchSize;
        return { deleted, hasMore };
      }

      case "integrations": {
        const docs = await ctx.db
          .query("integrations")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .take(batchSize * 2);
        for (const doc of docs) {
          if (!filterByPlatform || platforms!.includes(doc.platform as Platform)) {
            await ctx.db.delete(doc._id);
            deleted++;
            if (deleted >= batchSize) break;
          }
        }
        // Continue if: full page fetched (more docs might exist) OR hit deletion limit (didn't scan all fetched docs)
        const hasMore = docs.length === batchSize * 2 || deleted >= batchSize;
        return { deleted, hasMore };
      }

      case "actions": {
        const docs = await ctx.db
          .query("actions")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .take(batchSize * 2);
        for (const doc of docs) {
          // Actions without platform are deleted when deleting all, kept when filtering
          if (!filterByPlatform || (doc.platform && platforms!.includes(doc.platform as Platform))) {
            await ctx.db.delete(doc._id);
            deleted++;
            if (deleted >= batchSize) break;
          }
        }
        // Continue if: full page fetched (more docs might exist) OR hit deletion limit (didn't scan all fetched docs)
        const hasMore = docs.length === batchSize * 2 || deleted >= batchSize;
        return { deleted, hasMore };
      }

      case "messageQueue": {
        const docs = await ctx.db
          .query("messageQueue")
          .withIndex("by_user_status", (q) => q.eq("userId", userId))
          .take(batchSize * 2);
        for (const doc of docs) {
          if (!filterByPlatform || platforms!.includes(doc.platform as Platform)) {
            await ctx.db.delete(doc._id);
            deleted++;
            if (deleted >= batchSize) break;
          }
        }
        // Continue if: full page fetched (more docs might exist) OR hit deletion limit (didn't scan all fetched docs)
        const hasMore = docs.length === batchSize * 2 || deleted >= batchSize;
        return { deleted, hasMore };
      }

      // Non-platform tables (only deleted when no platform filter)
      case "actionAnalysisQueue": {
        if (filterByPlatform) return { deleted: 0, hasMore: false };
        const docs = await ctx.db
          .query("actionAnalysisQueue")
          .withIndex("by_user_status", (q) => q.eq("userId", userId))
          .take(batchSize);
        for (const doc of docs) {
          await ctx.db.delete(doc._id);
          deleted++;
        }
        return { deleted, hasMore: docs.length === batchSize };
      }

      case "mergeSuggestions": {
        if (filterByPlatform) return { deleted: 0, hasMore: false };
        const docs = await ctx.db
          .query("mergeSuggestions")
          .withIndex("by_user_status", (q) => q.eq("userId", userId))
          .take(batchSize);
        for (const doc of docs) {
          await ctx.db.delete(doc._id);
          deleted++;
        }
        return { deleted, hasMore: docs.length === batchSize };
      }

      case "devicePresence": {
        if (filterByPlatform) return { deleted: 0, hasMore: false };
        const docs = await ctx.db
          .query("devicePresence")
          .withIndex("by_user_device", (q) => q.eq("userId", userId))
          .take(batchSize);
        for (const doc of docs) {
          await ctx.db.delete(doc._id);
          deleted++;
        }
        return { deleted, hasMore: docs.length === batchSize };
      }

      default:
        return { deleted: 0, hasMore: false };
    }
  },
});

/**
 * Internal mutation to delete orphaned contacts (contacts with no handles).
 */
export const deleteOrphanedContacts = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const contacts = await ctx.db
      .query("contacts")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(DEFAULT_BATCH_SIZE);

    let deleted = 0;
    for (const contact of contacts) {
      const handles = await ctx.db
        .query("contactHandles")
        .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
        .first();

      if (!handles) {
        await ctx.db.delete(contact._id);
        deleted++;
      }
    }

    return { deleted, hasMore: contacts.length === DEFAULT_BATCH_SIZE };
  },
});

/**
 * Internal mutation to delete ALL contacts (when no platform filter).
 */
export const deleteAllContacts = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const contacts = await ctx.db
      .query("contacts")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(DEFAULT_BATCH_SIZE);

    for (const contact of contacts) {
      await ctx.db.delete(contact._id);
    }

    return { deleted: contacts.length, hasMore: contacts.length === DEFAULT_BATCH_SIZE };
  },
});

/**
 * Internal mutation to disconnect integrations (set isConnected = false).
 * Used by resetPlatformData to simulate fresh signup without deleting integration rows.
 */
export const disconnectIntegrations = internalMutation({
  args: {
    userId: v.id("users"),
    platforms: v.optional(v.array(platformValidator)),
  },
  handler: async (ctx, args) => {
    const { userId, platforms } = args;
    const filterByPlatform = platforms && platforms.length > 0;

    const integrations = await ctx.db
      .query("integrations")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    let disconnected = 0;
    for (const integration of integrations) {
      if (!filterByPlatform || platforms!.includes(integration.platform as Platform)) {
        await ctx.db.patch(integration._id, {
          isConnected: false,
          nangoConnectionId: undefined,
          lastError: undefined,
        });
        disconnected++;
      }
    }

    return { disconnected };
  },
});

/**
 * Authenticated action to reset platform data for debugging.
 * Simulates a fresh signup by:
 * - Deleting messages, conversations, handles, cursors, actions
 * - Setting integrations to disconnected (isConnected = false)
 * - Deleting orphaned contacts (or all contacts if resetting all platforms)
 *
 * @param platforms - Optional array of platforms to reset.
 *                    If omitted, resets ALL platforms.
 */
interface ResetPlatformDataResult {
  success: boolean;
  totalDeleted: number;
  integrationsDisconnected: number;
  byTable: Record<string, number>;
  platformsReset: string[] | "all";
}

export const resetPlatformData = action({
  args: {
    platforms: v.optional(v.array(platformValidator)),
    confirmReset: v.literal("CONFIRM_RESET"),
  },
  handler: async (ctx, args): Promise<ResetPlatformDataResult> => {
    // Authenticate user
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.runQuery(internal.users.getUserByWorkosId, {
      workosUserId: identity.subject,
    });
    if (!user) {
      throw new Error("User not found");
    }

    const userId = user._id;
    const { platforms } = args;
    const filterByPlatform = platforms && platforms.length > 0;

    // Tables with platform field (excluding integrations - handled separately)
    const platformTables = [
      "messages",
      "conversations",
      "contactHandles",
      "syncCursors",
      "actions",
      "messageQueue",
    ];

    // Tables without platform field (only deleted when no filter)
    const globalTables = [
      "actionAnalysisQueue",
      "mergeSuggestions",
      "devicePresence",
    ];

    const allTables = [...platformTables, ...globalTables];
    const stats: Record<string, number> = {};
    let totalDeleted = 0;

    // Delete from all tables
    for (const table of allTables) {
      stats[table] = 0;
      let hasMore = true;

      while (hasMore) {
        const result: { deleted: number; hasMore: boolean } = await ctx.runMutation(
          internal.debug.deleteBatchFiltered,
          { userId, table, platforms }
        );
        stats[table] += result.deleted;
        totalDeleted += result.deleted;
        hasMore = result.hasMore;

        if (result.deleted > 0) {
          console.log(`Deleted ${result.deleted} from ${table} (total: ${stats[table]})`);
        }
      }
    }

    // Handle contacts separately
    stats["contacts"] = 0;
    if (filterByPlatform) {
      // Delete orphaned contacts (contacts with no remaining handles)
      let hasMore = true;
      while (hasMore) {
        const result: { deleted: number; hasMore: boolean } = await ctx.runMutation(
          internal.debug.deleteOrphanedContacts,
          { userId }
        );
        stats["contacts"] += result.deleted;
        totalDeleted += result.deleted;
        hasMore = result.hasMore;

        if (result.deleted > 0) {
          console.log(`Deleted ${result.deleted} orphaned contacts (total: ${stats["contacts"]})`);
        }
      }
    } else {
      // Delete all contacts
      let hasMore = true;
      while (hasMore) {
        const result: { deleted: number; hasMore: boolean } = await ctx.runMutation(
          internal.debug.deleteAllContacts,
          { userId }
        );
        stats["contacts"] += result.deleted;
        totalDeleted += result.deleted;
        hasMore = result.hasMore;

        if (result.deleted > 0) {
          console.log(`Deleted ${result.deleted} contacts (total: ${stats["contacts"]})`);
        }
      }
    }

    // Disconnect integrations (set isConnected = false instead of deleting)
    const disconnectResult: { disconnected: number } = await ctx.runMutation(
      internal.debug.disconnectIntegrations,
      { userId, platforms }
    );
    stats["integrations"] = disconnectResult.disconnected;

    console.log(`Platform data reset complete. Total deleted: ${totalDeleted}, Integrations disconnected: ${disconnectResult.disconnected}`);

    return {
      success: true,
      totalDeleted,
      integrationsDisconnected: disconnectResult.disconnected,
      byTable: stats,
      platformsReset: filterByPlatform ? platforms! : "all",
    };
  },
});

// ============================================================================
// Platform Sync Debug Query
// ============================================================================

/**
 * Get sync status for a specific platform. Useful for debugging sync issues.
 * Shows: conversations, recent messages, cursors, and what might be filtered.
 */
export const getPlatformSyncStatus = query({
  args: {
    platform: platformValidator,
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return null;

    // Get conversations for this platform
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", user._id).eq("platform", args.platform)
      )
      .collect();

    // Get sync cursors
    const cursors = await ctx.db
      .query("syncCursors")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", user._id).eq("platform", args.platform)
      )
      .collect();

    // Get recent platform messages (take 50 total, filter to platform)
    // Note: No by_user_platform index on messages, so we filter post-query
    const recentMessages = await ctx.db
      .query("messages")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(50);
    const platformMessages = recentMessages.filter((m) => m.platform === args.platform);

    // Get pending actions for this platform
    const pendingActions = await ctx.db
      .query("actions")
      .withIndex("by_user_status", (q) => q.eq("userId", user._id).eq("status", "pending"))
      .collect();
    const platformActions = pendingActions.filter((a) => a.platform === args.platform);

    // Get integration status
    const integration = await ctx.db
      .query("integrations")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", user._id).eq("platform", args.platform)
      )
      .unique();

    return {
      platform: args.platform,
      integration: integration
        ? {
            isConnected: integration.isConnected,
            nangoConnectionId: integration.nangoConnectionId,
            lastError: integration.lastError,
          }
        : null,
      cursors: cursors.map((c) => ({
        workspaceId: c.workspaceId,
        lastSyncAt: c.lastSyncAt ? new Date(c.lastSyncAt).toISOString() : null,
        syncMode: c.syncMode,
        totalMessagesSynced: c.totalMessagesSynced,
        cursorData: c.cursorData,
      })),
      stats: {
        totalConversations: conversations.length,
        totalRecentMessages: platformMessages.length,
        pendingActions: platformActions.length,
      },
      recentConversations: conversations.slice(0, 10).map((c) => ({
        id: c._id,
        displayName: c.displayName,
        lastMessageAt: c.lastMessageAt ? new Date(c.lastMessageAt).toISOString() : null,
        lastMessageText: c.lastMessageText?.slice(0, 50),
        workspaceId: c.workspaceId,
      })),
      recentMessages: platformMessages.slice(0, 10).map((m) => ({
        id: m._id,
        content: m.content?.slice(0, 100),
        sentAt: new Date(m.sentAt).toISOString(),
        isFromMe: m.isFromMe,
        platformMessageId: m.platformMessageId,
      })),
    };
  },
});
