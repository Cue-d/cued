import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { findUserByWorkosId } from "./lib/auth";

// Heartbeat is considered stale after 30 seconds (2x the 15s heartbeat interval)
const STALE_THRESHOLD_MS = 30_000;

/**
 * Get authenticated user or throw. Used by mutations.
 */
async function getAuthenticatedUser(ctx: MutationCtx | QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthorized");

  const user = await findUserByWorkosId(ctx, identity.subject);
  if (!user) throw new Error("User not found");

  return user;
}

/**
 * Get electron presence record for a user.
 */
async function getElectronPresence(ctx: MutationCtx | QueryCtx, userId: string) {
  return ctx.db
    .query("devicePresence")
    .withIndex("by_user_device", (q) =>
      q.eq("userId", userId as never).eq("deviceType", "electron")
    )
    .first();
}

/**
 * Send heartbeat from electron app to indicate it's online.
 * Called every 15 seconds by the electron app.
 */
export const heartbeat = mutation({
  args: {
    appVersion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    const existing = await getElectronPresence(ctx, user._id);
    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        lastHeartbeatAt: now,
        appVersion: args.appVersion,
      });
    } else {
      await ctx.db.insert("devicePresence", {
        userId: user._id,
        deviceType: "electron",
        lastHeartbeatAt: now,
        appVersion: args.appVersion,
      });
    }

    return { success: true };
  },
});

/**
 * Disconnect the electron app (called on graceful shutdown).
 * Sets lastHeartbeatAt to 0 so the device is immediately marked offline.
 */
export const disconnect = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthenticatedUser(ctx);
    const existing = await getElectronPresence(ctx, user._id);

    if (existing) {
      await ctx.db.patch(existing._id, { lastHeartbeatAt: 0 });
    }

    return { success: true };
  },
});

/**
 * Get the electron app's online status for the current user.
 * Returns isOnline=true if heartbeat received within last 30 seconds.
 * pollTick is unused but forces client to re-fetch on interval.
 */
export const getElectronStatus = query({
  args: {
    pollTick: v.optional(v.number()),
  },
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { isOnline: false, lastSeen: null };

    const user = await findUserByWorkosId(ctx, identity.subject);
    if (!user) return { isOnline: false, lastSeen: null };

    const presence = await getElectronPresence(ctx, user._id);
    if (!presence) return { isOnline: false, lastSeen: null };

    const isOnline = Date.now() - presence.lastHeartbeatAt < STALE_THRESHOLD_MS;

    return { isOnline, lastSeen: presence.lastHeartbeatAt };
  },
});

/**
 * Internal mutation to mark stale devices as offline.
 * Called by cron job every 30 seconds.
 */
export const markStaleDevicesOffline = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const staleThreshold = now - STALE_THRESHOLD_MS;

    // Find all devices that haven't sent a heartbeat recently
    // and update their lastHeartbeatAt to trigger reactive queries
    const allDevices = await ctx.db.query("devicePresence").collect();

    let markedCount = 0;
    for (const device of allDevices) {
      // If the device is stale but lastHeartbeatAt is recent (not already marked),
      // update it to trigger the reactive query on mobile
      if (device.lastHeartbeatAt > 0 && device.lastHeartbeatAt < staleThreshold) {
        // Set to 0 to mark as offline and trigger reactive update
        await ctx.db.patch(device._id, { lastHeartbeatAt: 0 });
        markedCount++;
      }
    }

    return { markedCount };
  },
});
