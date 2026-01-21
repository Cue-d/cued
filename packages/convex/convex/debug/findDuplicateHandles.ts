/**
 * Diagnostic query to find duplicate contactHandles.
 * Run with: npx convex run debug/findDuplicateHandles:findDuplicates
 */

import { query } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

interface DuplicateGroup {
  handle: string;
  handleType: string;
  count: number;
  handles: Array<{
    _id: string;
    contactId: string;
    platform: string;
  }>;
  contacts: Array<{
    _id: string;
    displayName: string;
  }>;
}

/**
 * Find all duplicate contactHandles (same userId + handle appearing multiple times).
 */
export const findDuplicates = query({
  args: {},
  handler: async (ctx): Promise<{
    totalHandles: number;
    duplicateGroups: DuplicateGroup[];
    summary: {
      totalDuplicateHandles: number;
      totalDuplicateRecords: number;
      affectedContacts: number;
    };
  }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Must be authenticated");
    }

    // Get all handles for this user
    const allHandles = await ctx.db.query("contactHandles").collect();

    // Filter to current user's handles
    const user = await ctx.db
      .query("users")
      .withIndex("by_workos_id", (q) => q.eq("workosUserId", identity.subject))
      .unique();

    if (!user) {
      throw new Error("User not found");
    }

    const userHandles = allHandles.filter((h) => h.userId === user._id);

    // Group by normalized handle
    const handleGroups = new Map<string, Doc<"contactHandles">[]>();
    for (const handle of userHandles) {
      const key = handle.handle.toLowerCase();
      const group = handleGroups.get(key) ?? [];
      group.push(handle);
      handleGroups.set(key, group);
    }

    // Find duplicates (groups with more than 1 entry)
    const duplicateGroups: DuplicateGroup[] = [];
    const affectedContactIds = new Set<string>();

    for (const [handle, handles] of handleGroups) {
      if (handles.length > 1) {
        // Fetch contact info for each duplicate
        const contacts: Array<{ _id: string; displayName: string }> = [];
        for (const h of handles) {
          const contact = await ctx.db.get(h.contactId);
          if (contact) {
            contacts.push({
              _id: contact._id,
              displayName: contact.displayName,
            });
            affectedContactIds.add(contact._id);
          }
        }

        duplicateGroups.push({
          handle,
          handleType: handles[0].handleType,
          count: handles.length,
          handles: handles.map((h) => ({
            _id: h._id,
            contactId: h.contactId,
            platform: h.platform,
          })),
          contacts,
        });
      }
    }

    // Sort by count descending
    duplicateGroups.sort((a, b) => b.count - a.count);

    return {
      totalHandles: userHandles.length,
      duplicateGroups,
      summary: {
        totalDuplicateHandles: duplicateGroups.length,
        totalDuplicateRecords: duplicateGroups.reduce((sum, g) => sum + g.count, 0),
        affectedContacts: affectedContactIds.size,
      },
    };
  },
});
