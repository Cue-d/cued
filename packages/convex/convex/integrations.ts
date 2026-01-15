import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthenticatedUser, findUserByWorkosId } from "./lib/auth";

const platformValidator = v.union(
  v.literal("imessage"),
  v.literal("gmail"),
  v.literal("slack")
);

type Platform = "imessage" | "gmail" | "slack";

// Map Nango integration IDs to our platform enum
function nangoToPlatform(nangoIntegrationId: string): Platform | null {
  const mapping: Record<string, Platform> = {
    "google-mail": "gmail",
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
 * Connect a Nango integration. Called from webhook when user completes OAuth.
 * Uses WorkOS ID to find or create user.
 */
export const connectNango = mutation({
  args: {
    workosUserId: v.string(),
    nangoIntegrationId: v.string(), // e.g., "google-mail", "slack"
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
