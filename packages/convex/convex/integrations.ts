import { v } from "convex/values";
import { query } from "./_generated/server";
import { getAuthenticatedUser } from "./lib/auth";

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
