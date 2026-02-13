import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthenticatedUser, findUserByWorkosId } from "./lib/auth";
import {
  buildCursorMap,
  buildPlatformAggregates,
  aggregateCursorStats,
} from "./lib/cursors";
import { platformValidator } from "./schema";

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

    // Get all sync cursors for this user to join with integrations
    const cursors = await ctx.db
      .query("syncCursors")
      .withIndex("by_user_platform", (q) => q.eq("userId", user._id))
      .collect();

    const cursorMap = buildCursorMap(cursors);
    const platformAggregates = buildPlatformAggregates(cursors);

    const slackWorkspaces = integrations
      .filter((i) => i.platform === "slack" && i.isConnected && i.slackTeamId)
      .map((i) => {
        const cursor = cursorMap.get(`slack:${i.slackTeamId}`);
        return {
          workspaceId: i.slackTeamId!,
          lastSyncAt: cursor?.lastSyncAt ?? null,
          totalMessagesSynced: cursor?.totalMessagesSynced ?? 0,
        };
      });

    return {
      integrations: integrations.map((int) => {
        // For Slack with slackTeamId, look up by composite key
        // For other platforms, try composite key first, then fall back to platform-only or aggregate
        let cursor;
        let aggregateStats;

        if (int.platform === "slack" && int.slackTeamId) {
          cursor = cursorMap.get(`slack:${int.slackTeamId}`);
        } else {
          // For non-workspace platforms (iMessage, LinkedIn), use platform key
          cursor = cursorMap.get(int.platform);
          if (!cursor && int.platform === "slack") {
            // Multi-workspace platform without specific match: use aggregated stats
            aggregateStats = platformAggregates.get(int.platform);
          }
        }

        // Attach accounts for multi-workspace platforms
        let accounts: Array<{
          workspaceId: string;
          lastSyncAt: number | null;
          totalMessagesSynced: number;
        }> | null = null;
        if (int.platform === "slack") {
          accounts = slackWorkspaces;
        }

        return {
          _id: int._id,
          platform: int.platform,
          isConnected: int.isConnected,
          lastSyncAt: cursor?.lastSyncAt ?? aggregateStats?.lastSyncAt ?? null,
          lastError: int.lastError ?? null,
          totalMessagesSynced:
            cursor?.totalMessagesSynced ?? aggregateStats?.totalMessagesSynced ?? 0,
          accounts,
        };
      }),
    };
  },
});

export const getIntegrationStatus = query({
  args: {
    platform: v.union(
      v.literal("imessage"),
      v.literal("slack"),
      v.literal("linkedin"),
      v.literal("signal")
    ),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) {
      return null;
    }

    // Use .collect() for multi-account platforms (Slack can have multiple workspaces)
    const integrations = await ctx.db
      .query("integrations")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", user._id).eq("platform", args.platform)
      )
      .collect();

    if (integrations.length === 0) {
      return { isConnected: false };
    }

    // Collect all cursors for this platform (supports multi-workspace: Slack)
    const cursors = await ctx.db
      .query("syncCursors")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", user._id).eq("platform", args.platform)
      )
      .collect();

    const stats = aggregateCursorStats(cursors);

    // Aggregate across all integrations: connected if any is connected
    const connectedIntegrations = integrations.filter((i) => i.isConnected);
    const isConnected = connectedIntegrations.length > 0;
    // Use first error found (if any)
    const lastError = integrations.find((i) => i.lastError)?.lastError ?? null;

    return {
      isConnected,
      connectedAccounts: connectedIntegrations.length,
      lastSyncAt: stats.lastSyncAt,
      lastError,
      totalMessagesSynced: stats.totalMessagesSynced,
    };
  },
});

/**
 * Get integration by WorkOS user ID and platform.
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

    // For multi-account platforms, collect all and filter
    const integrations = await ctx.db
      .query("integrations")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", user._id).eq("platform", args.platform)
      )
      .collect();

    if (integrations.length === 0) {
      return null;
    }

    // Return first connected integration, or just first if none connected
    const integration = integrations.find((i) => i.isConnected) ?? integrations[0];

    return {
      _id: integration._id,
      platform: integration.platform,
      isConnected: integration.isConnected,
    };
  },
});

// ============================================================================
// Native Slack Integration (Local-Only Auth)
// ============================================================================

/**
 * Update Slack connection status from Electron.
 * Stores ONLY metadata (teamId, teamName, userId, isConnected).
 * NO tokens or cookies are stored in Convex - those stay local.
 * Supports multiple workspaces per user via slackTeamId.
 */
export const updateSlackStatus = mutation({
  args: {
    workosUserId: v.string(),
    teamId: v.string(),
    teamName: v.string(),
    userId: v.string(), // Slack user ID
    isConnected: v.boolean(),
  },
  handler: async (ctx, args) => {
    // Find or create user
    const user = await findUserByWorkosId(ctx, args.workosUserId);
    if (!user) {
      throw new Error("User not found");
    }

    // Check if Slack integration already exists for this specific team
    const existing = await ctx.db
      .query("integrations")
      .withIndex("by_user_platform_team", (q) =>
        q.eq("userId", user._id).eq("platform", "slack").eq("slackTeamId", args.teamId)
      )
      .unique();

    if (existing) {
      // Update existing integration
      await ctx.db.patch(existing._id, {
        connectedAt: args.isConnected ? Date.now() : existing.connectedAt,
        slackTeamId: args.teamId,
        isConnected: args.isConnected,
        lastError: args.isConnected ? undefined : existing.lastError,
      });

      console.log(
        `[Slack] Updated status for team ${args.teamName} (${args.teamId}), user ${args.userId}, connected: ${args.isConnected}`
      );

      return { integrationId: existing._id, updated: true };
    }

    // Create new integration for this workspace
    const integrationId = await ctx.db.insert("integrations", {
      userId: user._id,
      platform: "slack",
      slackTeamId: args.teamId,
      connectedAt: args.isConnected ? Date.now() : undefined,
      isConnected: args.isConnected,
    });

    console.log(
      `[Slack] Created integration for team ${args.teamName} (${args.teamId}), user ${args.userId}`
    );

    return { integrationId, updated: false };
  },
});

/**
 * Get Slack connection status for all workspaces.
 * Returns an array of connected workspaces (supports multi-workspace).
 */
export const getSlackStatus = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) {
      return { isConnected: false, workspaces: [] };
    }

    // Get all Slack integrations for this user
    const integrations = await ctx.db
      .query("integrations")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", user._id).eq("platform", "slack")
      )
      .collect();

    if (integrations.length === 0) {
      return { isConnected: false, workspaces: [] };
    }

    // Get all Slack sync cursors for stats (keyed by workspaceId = teamId)
    const cursors = await ctx.db
      .query("syncCursors")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", user._id).eq("platform", "slack")
      )
      .collect();

    const cursorMap = new Map(cursors.map((c) => [c.workspaceId, c]));

    const workspaces = integrations
      .filter((i) => i.isConnected)
      .map((i) => {
        const cursor = cursorMap.get(i.slackTeamId ?? undefined);
        return {
          teamId: i.slackTeamId ?? null,
          isConnected: i.isConnected,
          lastSyncAt: cursor?.lastSyncAt ?? null,
          lastError: i.lastError ?? null,
          totalMessagesSynced: cursor?.totalMessagesSynced ?? 0,
        };
      });

    // For backward compatibility, also return top-level isConnected
    return {
      isConnected: workspaces.some((w) => w.isConnected),
      workspaces,
      // Legacy fields from first workspace (backward compatibility)
      lastSyncAt: workspaces[0]?.lastSyncAt ?? null,
      lastError: workspaces[0]?.lastError ?? null,
      totalMessagesSynced: workspaces.reduce((sum, w) => sum + (w.totalMessagesSynced ?? 0), 0),
    };
  },
});

/**
 * Disconnect Slack integration.
 * Called when user disconnects from Electron settings.
 * If teamId is provided, disconnects only that workspace.
 * If teamId is not provided, disconnects all Slack workspaces.
 */
export const disconnectSlack = mutation({
  args: {
    workosUserId: v.string(),
    teamId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await findUserByWorkosId(ctx, args.workosUserId);
    if (!user) {
      return { success: false, error: "User not found" };
    }

    // If teamId specified, disconnect only that workspace
    if (args.teamId) {
      const integration = await ctx.db
        .query("integrations")
        .withIndex("by_user_platform_team", (q) =>
          q.eq("userId", user._id).eq("platform", "slack").eq("slackTeamId", args.teamId)
        )
        .unique();

      if (!integration) {
        return { success: false, error: "No Slack integration found for this team" };
      }

      await ctx.db.patch(integration._id, {
        isConnected: false,
      });

      console.log(`[Slack] Disconnected workspace ${args.teamId}`);
      return { success: true };
    }

    // Otherwise, disconnect all Slack workspaces
    const integrations = await ctx.db
      .query("integrations")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", user._id).eq("platform", "slack")
      )
      .collect();

    if (integrations.length === 0) {
      return { success: false, error: "No Slack integrations found" };
    }

    for (const integration of integrations) {
      await ctx.db.patch(integration._id, {
        isConnected: false,
      });
    }

    console.log(`[Slack] Disconnected ${integrations.length} workspaces`);
    return { success: true };
  },
});

// ============================================================================
// LinkedIn Integration (Local-Only Auth)
// ============================================================================

/**
 * Update LinkedIn connection status from Electron.
 * Stores metadata including user's LinkedIn URN for isFromMe detection.
 */
export const updateLinkedInStatus = mutation({
  args: {
    workosUserId: v.string(),
    userURN: v.string(), // User's LinkedIn URN (e.g., urn:li:fsd_profile:ABC123)
    isConnected: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await findUserByWorkosId(ctx, args.workosUserId);
    if (!user) {
      throw new Error("User not found");
    }

    // Check if LinkedIn integration already exists
    const existing = await ctx.db
      .query("integrations")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", user._id).eq("platform", "linkedin")
      )
      .unique();

    if (existing) {
      // Update existing integration
      await ctx.db.patch(existing._id, {
        linkedInUserURN: args.userURN,
        connectedAt: args.isConnected ? Date.now() : existing.connectedAt,
        isConnected: args.isConnected,
        lastError: args.isConnected ? undefined : existing.lastError,
      });

      console.log(
        `[LinkedIn] Updated status for user ${args.userURN}, connected: ${args.isConnected}`
      );

      return { integrationId: existing._id, updated: true };
    }

    // Create new integration
    const integrationId = await ctx.db.insert("integrations", {
      userId: user._id,
      platform: "linkedin",
      linkedInUserURN: args.userURN,
      connectedAt: args.isConnected ? Date.now() : undefined,
      isConnected: args.isConnected,
    });

    console.log(`[LinkedIn] Created integration for user ${args.userURN}`);

    return { integrationId, updated: false };
  },
});

/**
 * Get LinkedIn connection status.
 */
export const getLinkedInStatus = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) {
      return { isConnected: false };
    }

    const integration = await ctx.db
      .query("integrations")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", user._id).eq("platform", "linkedin")
      )
      .unique();

    if (!integration) {
      return { isConnected: false };
    }

    const cursor = await ctx.db
      .query("syncCursors")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", user._id).eq("platform", "linkedin")
      )
      .unique();

    return {
      isConnected: integration.isConnected,
      lastSyncAt: cursor?.lastSyncAt ?? null,
      lastError: integration.lastError ?? null,
      totalMessagesSynced: cursor?.totalMessagesSynced ?? 0,
      userURN: integration.linkedInUserURN ?? null,
    };
  },
});

// ============================================================================
// Debug/Test Queries
// ============================================================================

/**
 * Debug: Get full integration details including connection IDs.
 * Returns data needed to manually trigger pulls.
 * Scoped to the authenticated user only.
 */
export const debugIntegrationDetails = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) {
      return [];
    }

    const integrations = await ctx.db
      .query("integrations")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    const cursors = await ctx.db
      .query("syncCursors")
      .withIndex("by_user_platform", (q) => q.eq("userId", user._id))
      .collect();

    // Key by (platform, workspaceId) to support multi-workspace platforms
    const cursorMap = new Map(
      cursors.map((c) => [
        c.workspaceId ? `${c.platform}-${c.workspaceId}` : c.platform,
        c,
      ])
    );

    return integrations.map((i) => {
      // For Slack with slackTeamId, use composite key
      const workspaceId = i.slackTeamId;
      const cursorKey = workspaceId
        ? `${i.platform}-${workspaceId}`
        : i.platform;
      const cursor = cursorMap.get(cursorKey);
      return {
        _id: i._id,
        platform: i.platform,
        slackTeamId: i.slackTeamId ?? null,
        isConnected: i.isConnected,
        lastSyncAt: cursor?.lastSyncAt
          ? new Date(cursor.lastSyncAt).toISOString()
          : null,
        cursorWorkspaceId: cursor?.workspaceId ?? null,
      };
    });
  },
});

