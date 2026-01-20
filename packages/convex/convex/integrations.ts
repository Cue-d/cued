import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthenticatedUser, findUserByWorkosId } from "./lib/auth";

const platformValidator = v.union(
  v.literal("imessage"),
  v.literal("gmail"),
  v.literal("slack"),
  v.literal("linkedin"),
  v.literal("twitter"),
  v.literal("signal"),
  v.literal("whatsapp")
);

type Platform = "imessage" | "gmail" | "slack" | "linkedin" | "twitter" | "signal" | "whatsapp";

// Map Nango integration IDs to our platform enum
function nangoToPlatform(nangoIntegrationId: string): Platform | null {
  const mapping: Record<string, Platform> = {
    google: "gmail",
    slack: "slack",
  };
  return mapping[nangoIntegrationId] ?? null;
}

export const getUserIntegrations = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) {
      return { integrations: [] };
    }

    const integrations = await ctx.db
      .query("integrations")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    return {
      integrations: integrations.map((int) => ({
        _id: int._id,
        platform: int.platform,
        isConnected: int.syncState.isConnected,
        lastSyncAt: int.syncState.lastSyncAt ?? null,
        lastError: int.syncState.lastError ?? null,
        totalMessagesSynced: int.syncState.totalMessagesSynced ?? 0,
        nangoConnectionId: int.nangoConnectionId ?? null,
      })),
    };
  },
});

export const getIntegrationStatus = query({
  args: {
    platform: v.union(v.literal("imessage"), v.literal("gmail"), v.literal("slack")),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) {
      return null;
    }

    const integration = await ctx.db
      .query("integrations")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", user._id).eq("platform", args.platform)
      )
      .unique();

    if (!integration) {
      return { isConnected: false };
    }

    return {
      isConnected: integration.syncState.isConnected,
      lastSyncAt: integration.syncState.lastSyncAt ?? null,
      lastError: integration.syncState.lastError ?? null,
      totalMessagesSynced: integration.syncState.totalMessagesSynced ?? 0,
    };
  },
});

/**
 * Get integration by WorkOS user ID and platform.
 * Task 5.8: Used by API routes to get Nango connection ID for message sending.
 */
export const getIntegration = query({
  args: {
    workosUserId: v.string(),
    platform: platformValidator,
  },
  handler: async (ctx, args) => {
    const user = await findUserByWorkosId(ctx, args.workosUserId);
    if (!user) {
      return null;
    }

    const integration = await ctx.db
      .query("integrations")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", user._id).eq("platform", args.platform)
      )
      .unique();

    if (!integration) {
      return null;
    }

    return {
      _id: integration._id,
      platform: integration.platform,
      nangoConnectionId: integration.nangoConnectionId ?? null,
      isConnected: integration.syncState.isConnected,
    };
  },
});

/**
 * Connect a Nango integration. Called from webhook when user completes OAuth.
 * Uses WorkOS ID to find or create user.
 */
export const connectNango = mutation({
  args: {
    workosUserId: v.string(),
    nangoIntegrationId: v.string(), // e.g., "google", "slack"
    nangoConnectionId: v.string(),
    email: v.optional(v.string()), // From endUser.endUserEmail
  },
  handler: async (ctx, args) => {
    const platform = nangoToPlatform(args.nangoIntegrationId);
    if (!platform) {
      throw new Error(`Unknown Nango integration: ${args.nangoIntegrationId}`);
    }

    // Find or create user
    let user = await findUserByWorkosId(ctx, args.workosUserId);
    if (!user) {
      // Create user if they don't exist (first connection via Nango, no Electron sync yet)
      const userId = await ctx.db.insert("users", {
        workosUserId: args.workosUserId,
        email: args.email ?? "",
      });
      user = await ctx.db.get(userId);
      if (!user) {
        throw new Error("Failed to create user");
      }
    }

    // Check if integration already exists
    const existing = await ctx.db
      .query("integrations")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", user._id).eq("platform", platform)
      )
      .unique();

    if (existing) {
      // Update existing integration
      await ctx.db.patch(existing._id, {
        nangoConnectionId: args.nangoConnectionId,
        connectedAt: Date.now(),
        syncState: {
          ...existing.syncState,
          isConnected: true,
          lastError: undefined,
        },
      });
      return { integrationId: existing._id, updated: true };
    }

    // Create new integration
    const integrationId = await ctx.db.insert("integrations", {
      userId: user._id,
      platform,
      nangoConnectionId: args.nangoConnectionId,
      connectedAt: Date.now(),
      syncState: {
        isConnected: true,
      },
    });

    return { integrationId, updated: false };
  },
});

/**
 * Disconnect a Nango integration. Called from webhook when connection is deleted.
 */
export const disconnectNango = mutation({
  args: {
    workosUserId: v.string(),
    nangoConnectionId: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await findUserByWorkosId(ctx, args.workosUserId);
    if (!user) {
      return { success: false, error: "User not found" };
    }

    // Find integration by nangoConnectionId
    const integrations = await ctx.db
      .query("integrations")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    const integration = integrations.find(
      (i) => i.nangoConnectionId === args.nangoConnectionId
    );

    if (!integration) {
      return { success: false, error: "Integration not found" };
    }

    // Update to disconnected state
    await ctx.db.patch(integration._id, {
      nangoConnectionId: undefined,
      syncState: {
        ...integration.syncState,
        isConnected: false,
      },
    });

    return { success: true };
  },
});

// ============================================================================
// Debug/Test Queries
// ============================================================================

/**
 * Debug query to get Gmail integration status and stats.
 * Used for E2E testing verification (Task 4.14).
 */
/**
 * Debug: Get full integration details including connection IDs.
 * Returns data needed to manually trigger pulls.
 */
export const debugIntegrationDetails = query({
  args: {},
  handler: async (ctx) => {
    const integrations = await ctx.db.query("integrations").collect();
    const users = await ctx.db.query("users").collect();

    const userMap = new Map(users.map((u) => [u._id, u]));

    return integrations.map((i) => ({
      _id: i._id,
      platform: i.platform,
      userId: i.userId,
      workosUserId: userMap.get(i.userId)?.workosUserId ?? "unknown",
      nangoConnectionId: i.nangoConnectionId ?? null,
      isConnected: i.syncState.isConnected,
      lastSyncAt: i.syncState.lastSyncAt
        ? new Date(i.syncState.lastSyncAt).toISOString()
        : null,
    }));
  },
});

export const debugGmailStats = query({
  args: {},
  handler: async (ctx) => {
    // Get all integrations (small table)
    const allIntegrations = await ctx.db.query("integrations").collect();
    const gmailIntegrations = allIntegrations.filter((i) => i.platform === "gmail");

    // Sample Gmail conversations (limit query to avoid scanning entire table)
    const gmailConversations = await ctx.db
      .query("conversations")
      .order("desc")
      .take(100);
    const filteredConversations = gmailConversations.filter((c) => c.platform === "gmail");

    // Sample Gmail messages (limit query)
    const recentMessages = await ctx.db
      .query("messages")
      .order("desc")
      .take(100);
    const gmailMessages = recentMessages.filter((m) => m.platform === "gmail");

    return {
      integrations: gmailIntegrations.map((i) => ({
        _id: i._id,
        userId: i.userId,
        isConnected: i.syncState.isConnected,
        lastSyncAt: i.syncState.lastSyncAt
          ? new Date(i.syncState.lastSyncAt).toISOString()
          : null,
        totalMessagesSynced: i.syncState.totalMessagesSynced ?? 0,
        totalContactsSynced: i.syncState.totalContactsSynced ?? 0,
        hasNangoConnection: !!i.nangoConnectionId,
      })),
      stats: {
        conversationSample: filteredConversations.length,
        messageSample: gmailMessages.length,
        note: "Counts are sampled from last 100 records",
      },
      sampleConversations: filteredConversations.slice(0, 5).map((c) => ({
        _id: c._id,
        displayName: c.displayName,
        lastMessageAt: c.lastMessageAt
          ? new Date(c.lastMessageAt).toISOString()
          : null,
        lastMessagePreview: c.lastMessageText?.slice(0, 50),
      })),
    };
  },
});
