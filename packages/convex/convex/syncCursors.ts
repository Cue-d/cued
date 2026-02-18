/**
 * Sync cursor management for cloud-based cursor storage.
 * Enables multi-device sync by storing cursors in Convex instead of local files.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { platformValidator, syncModeValidator } from "./schema";
import { MULTI_WORKSPACE_PLATFORMS } from "@cued/shared";
import {
  findSyncCursor,
  upsertSyncCursor as upsertSyncCursorHelper,
} from "./sync/shared";
import { findUserByWorkosId } from "./lib/auth";

/**
 * Get the sync cursor for a platform (and optional workspace).
 * Returns null if no cursor exists.
 *
 * For multi-workspace platforms (slack), workspaceId is required.
 * For single-account platforms (imessage, linkedin), workspaceId is optional.
 */
export const getSyncCursor = query({
  args: {
    platform: platformValidator,
    workspaceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    // Require workspaceId for multi-workspace platforms
    if (
      MULTI_WORKSPACE_PLATFORMS.includes(
        args.platform as (typeof MULTI_WORKSPACE_PLATFORMS)[number]
      ) &&
      !args.workspaceId
    ) {
      throw new Error(
        `workspaceId is required for ${args.platform} (multi-workspace platform)`
      );
    }

    const user = await findUserByWorkosId(ctx, identity.subject);

    if (!user) return null;

    return findSyncCursor(ctx, user._id, args.platform, args.workspaceId);
  },
});

/**
 * List all sync cursors for a platform.
 * Useful for multi-workspace platforms to get all workspace cursors.
 */
export const listSyncCursors = query({
  args: {
    platform: platformValidator,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const user = await findUserByWorkosId(ctx, identity.subject);

    if (!user) return [];

    return ctx.db
      .query("syncCursors")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", user._id).eq("platform", args.platform)
      )
      .collect();
  },
});

/**
 * Upsert a sync cursor (create or update).
 * Uses last-write-wins for multi-device conflict resolution.
 *
 * For multi-workspace platforms (slack), workspaceId is required.
 */
export const upsertSyncCursor = mutation({
  args: {
    platform: platformValidator,
    workspaceId: v.optional(v.string()),
    cursorData: v.any(),
    syncMode: syncModeValidator,
    fullSyncProgress: v.optional(
      v.object({
        phase: v.string(),
        offset: v.number(),
      })
    ),
    // Optional stats fields (from old integrations.syncState)
    totalMessagesSynced: v.optional(v.number()),
    totalContactsSynced: v.optional(v.number()),
    lastContactsSyncAt: v.optional(v.number()),
    syncVersion: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to update sync cursor");
    }

    // Require workspaceId for multi-workspace platforms
    if (
      MULTI_WORKSPACE_PLATFORMS.includes(
        args.platform as (typeof MULTI_WORKSPACE_PLATFORMS)[number]
      ) &&
      !args.workspaceId
    ) {
      throw new Error(
        `workspaceId is required for ${args.platform} (multi-workspace platform)`
      );
    }

    const user = await findUserByWorkosId(ctx, identity.subject);

    if (!user) {
      throw new Error("User not found");
    }

    // Use shared helper for upsert logic
    return upsertSyncCursorHelper(ctx, user._id, args.platform, {
      cursorData: args.cursorData,
      syncMode: args.syncMode,
      workspaceId: args.workspaceId,
      fullSyncProgress: args.fullSyncProgress,
      totalMessagesSynced: args.totalMessagesSynced,
      totalContactsSynced: args.totalContactsSynced,
      lastContactsSyncAt: args.lastContactsSyncAt,
      syncVersion: args.syncVersion,
    });
  },
});

/**
 * Update only the stats fields on a sync cursor without changing cursor data.
 *
 * For multi-workspace platforms (slack), workspaceId is required.
 */
export const updateSyncStats = mutation({
  args: {
    platform: platformValidator,
    workspaceId: v.optional(v.string()),
    totalMessagesSynced: v.optional(v.number()),
    totalContactsSynced: v.optional(v.number()),
    lastContactsSyncAt: v.optional(v.number()),
    syncVersion: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to update sync stats");
    }

    // Require workspaceId for multi-workspace platforms
    if (
      MULTI_WORKSPACE_PLATFORMS.includes(
        args.platform as (typeof MULTI_WORKSPACE_PLATFORMS)[number]
      ) &&
      !args.workspaceId
    ) {
      throw new Error(
        `workspaceId is required for ${args.platform} (multi-workspace platform)`
      );
    }

    const user = await findUserByWorkosId(ctx, identity.subject);

    if (!user) {
      throw new Error("User not found");
    }

    const existingCursor = await findSyncCursor(ctx, user._id, args.platform, args.workspaceId);

    if (!existingCursor) {
      throw new Error(
        `No sync cursor found for platform ${args.platform}${args.workspaceId ? ` workspace ${args.workspaceId}` : ""}`
      );
    }

    // Update only the stats fields that were provided
    await ctx.db.patch(existingCursor._id, {
      ...(args.totalMessagesSynced !== undefined && {
        totalMessagesSynced: args.totalMessagesSynced,
      }),
      ...(args.totalContactsSynced !== undefined && {
        totalContactsSynced: args.totalContactsSynced,
      }),
      ...(args.lastContactsSyncAt !== undefined && {
        lastContactsSyncAt: args.lastContactsSyncAt,
      }),
      ...(args.syncVersion !== undefined && { syncVersion: args.syncVersion }),
    });

    return existingCursor._id;
  },
});

/**
 * Delete a sync cursor for a specific platform/workspace.
 * Used for cleanup or triggering a fresh full sync.
 *
 * For multi-workspace platforms (slack), workspaceId is required.
 */
export const deleteSyncCursor = mutation({
  args: {
    platform: platformValidator,
    workspaceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to delete sync cursor");
    }

    // Require workspaceId for multi-workspace platforms
    if (
      MULTI_WORKSPACE_PLATFORMS.includes(
        args.platform as (typeof MULTI_WORKSPACE_PLATFORMS)[number]
      ) &&
      !args.workspaceId
    ) {
      throw new Error(
        `workspaceId is required for ${args.platform} (multi-workspace platform)`
      );
    }

    const user = await findUserByWorkosId(ctx, identity.subject);

    if (!user) {
      throw new Error("User not found");
    }

    const existingCursor = await findSyncCursor(ctx, user._id, args.platform, args.workspaceId);

    if (existingCursor) {
      await ctx.db.delete(existingCursor._id);
      return true;
    }

    return false;
  },
});

/**
 * Reset all sync cursors for the current user.
 * Triggers a complete re-sync from scratch on all platforms.
 */
export const resetAllSyncCursors = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to reset sync cursors");
    }

    const user = await findUserByWorkosId(ctx, identity.subject);

    if (!user) {
      throw new Error("User not found");
    }

    // Get all cursors for this user
    const cursors = await ctx.db
      .query("syncCursors")
      .withIndex("by_user_platform", (q) => q.eq("userId", user._id))
      .collect();

    // Delete all of them
    let deleted = 0;
    for (const cursor of cursors) {
      await ctx.db.delete(cursor._id);
      deleted++;
    }

    return { deleted };
  },
});
