/**
 * Migration to clean up duplicate contactHandles created by past race conditions.
 *
 * Run with: npx convex run debug/cleanupDuplicateHandles:cleanupDuplicates
 *
 * This migration:
 * 1. Finds all duplicate contactHandles (same userId + handle)
 * 2. For each duplicate group, keeps the first handle and deletes the rest
 * 3. If duplicates point to different contacts, merges the contacts
 */

import { internalMutation, mutation } from "../_generated/server";
import { v } from "convex/values";
import type { Id, Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { findUserByWorkosId } from "../lib/auth";

interface DuplicateGroup {
  handle: string;
  handles: Doc<"contactHandles">[];
}

/**
 * Find all duplicate contactHandles for a user.
 */
async function findDuplicateHandles(
  ctx: MutationCtx,
  userId: Id<"users">
): Promise<DuplicateGroup[]> {
  // Get all handles for this user
  const allHandles = await ctx.db
    .query("contactHandles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();

  // Group by normalized handle
  const handleGroups = new Map<string, Doc<"contactHandles">[]>();
  for (const handle of allHandles) {
    const key = handle.handle.toLowerCase();
    const group = handleGroups.get(key) ?? [];
    group.push(handle);
    handleGroups.set(key, group);
  }

  // Return only groups with duplicates
  const duplicates: DuplicateGroup[] = [];
  for (const [handle, handles] of handleGroups) {
    if (handles.length > 1) {
      duplicates.push({ handle, handles });
    }
  }

  return duplicates;
}

/**
 * Merge two contacts: moves all handles and references from contact2 to contact1,
 * then deletes contact2.
 */
async function mergeContacts(
  ctx: MutationCtx,
  contact1Id: Id<"contacts">,
  contact2Id: Id<"contacts">
): Promise<void> {
  // Move all handles from contact2 to contact1
  const contact2Handles = await ctx.db
    .query("contactHandles")
    .withIndex("by_contact", (q) => q.eq("contactId", contact2Id))
    .collect();

  for (const handle of contact2Handles) {
    await ctx.db.patch(handle._id, { contactId: contact1Id });
  }

  // Update conversations that reference contact2
  const conversations = await ctx.db.query("conversations").collect();
  for (const conv of conversations) {
    if (conv.participantContactIds.includes(contact2Id)) {
      const newParticipants = conv.participantContactIds.map((id) =>
        id === contact2Id ? contact1Id : id
      );
      // Remove duplicates
      const uniqueParticipants = [...new Set(newParticipants)];
      await ctx.db.patch(conv._id, { participantContactIds: uniqueParticipants });
    }
  }

  // Update messages that reference contact2
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_sender_contact", (q) => q.eq("senderContactId", contact2Id))
    .collect();

  for (const msg of messages) {
    await ctx.db.patch(msg._id, { senderContactId: contact1Id });
  }

  // Update actions that reference contact2
  const actions = await ctx.db
    .query("actions")
    .withIndex("by_contact", (q) => q.eq("contactId", contact2Id))
    .collect();

  for (const action of actions) {
    await ctx.db.patch(action._id, { contactId: contact1Id });
  }

  // Delete contact2
  await ctx.db.delete(contact2Id);
}

/**
 * Clean up duplicate contactHandles for the current user.
 * Keeps the first handle in each duplicate group and deletes the rest.
 * Merges contacts if they point to different contacts.
 */
export const cleanupDuplicates = mutation({
  args: {
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Must be authenticated");
    }

    const user = await findUserByWorkosId(ctx, identity.subject);
    if (!user) {
      throw new Error("User not found");
    }

    const dryRun = args.dryRun ?? true; // Default to dry run for safety
    const duplicates = await findDuplicateHandles(ctx, user._id);

    const result = {
      dryRun,
      duplicateGroupsFound: duplicates.length,
      handlesDeleted: 0,
      contactsMerged: 0,
      details: [] as Array<{
        handle: string;
        kept: string;
        deleted: string[];
        contactsMerged: boolean;
      }>,
    };

    for (const group of duplicates) {
      // Sort by creation time (oldest first) - keep the oldest
      const sorted = group.handles.sort((a, b) => a._creationTime - b._creationTime);
      const keepHandle = sorted[0];
      const deleteHandles = sorted.slice(1);

      const detail = {
        handle: group.handle,
        kept: keepHandle._id,
        deleted: deleteHandles.map((h) => h._id),
        contactsMerged: false,
      };

      // Check if handles point to different contacts
      const uniqueContactIds = new Set(group.handles.map((h) => h.contactId));
      if (uniqueContactIds.size > 1) {
        detail.contactsMerged = true;
        result.contactsMerged++;

        if (!dryRun) {
          // Merge all contacts into the one pointed to by the kept handle
          const targetContactId = keepHandle.contactId;
          for (const handle of deleteHandles) {
            if (handle.contactId !== targetContactId) {
              await mergeContacts(ctx, targetContactId, handle.contactId);
            }
          }
        }
      }

      // Delete duplicate handles
      if (!dryRun) {
        for (const handle of deleteHandles) {
          await ctx.db.delete(handle._id);
        }
      }

      result.handlesDeleted += deleteHandles.length;
      result.details.push(detail);
    }

    return result;
  },
});

/**
 * Preview what the cleanup would do without making changes.
 */
export const previewCleanup = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Must be authenticated");
    }

    const user = await findUserByWorkosId(ctx, identity.subject);
    if (!user) {
      throw new Error("User not found");
    }

    const duplicates = await findDuplicateHandles(ctx, user._id);

    return {
      duplicateGroupsFound: duplicates.length,
      totalDuplicateRecords: duplicates.reduce((sum, g) => sum + g.handles.length, 0),
      wouldDelete: duplicates.reduce((sum, g) => sum + g.handles.length - 1, 0),
      wouldMergeContacts: duplicates.filter((g) => {
        const uniqueContacts = new Set(g.handles.map((h) => h.contactId));
        return uniqueContacts.size > 1;
      }).length,
      groups: duplicates.map((g) => ({
        handle: g.handle,
        count: g.handles.length,
        contactIds: [...new Set(g.handles.map((h) => h.contactId))],
      })),
    };
  },
});
