import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation } from "./_generated/server";

const BATCH_SIZE = 500;

type UserTable = "messages" | "conversations" | "contacts" | "contactHandles" | "actions";

/**
 * Delete all records from a table for a given user.
 * Uses batched deletion to handle large datasets.
 */
async function deleteAllByUser(
  ctx: MutationCtx,
  table: UserTable,
  userId: Id<"users">
): Promise<number> {
  let deleted = 0;
  while (true) {
    const records = await ctx.db
      .query(table)
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(BATCH_SIZE);
    if (records.length === 0) break;
    for (const record of records) {
      await ctx.db.delete(record._id);
      deleted++;
    }
  }
  return deleted;
}

/**
 * Delete all user data for testing/reset purposes.
 * This is a DESTRUCTIVE operation that removes:
 * - All messages
 * - All conversations
 * - All contacts and contact handles
 * - All actions
 * - Resets sync state in integrations
 *
 * Use with caution! This is intended for development testing only.
 */
export const resetAllUserData = mutation({
  args: {
    confirmReset: v.literal("I_UNDERSTAND_THIS_DELETES_ALL_MY_DATA"),
  },
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to reset data");
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_workos_id", (q) => q.eq("workosUserId", identity.subject))
      .unique();

    if (!user) {
      return { success: true, message: "No user found, nothing to reset" };
    }

    const userId = user._id;

    // Delete all user data
    const stats = {
      messagesDeleted: await deleteAllByUser(ctx, "messages", userId),
      conversationsDeleted: await deleteAllByUser(ctx, "conversations", userId),
      contactHandlesDeleted: await deleteAllByUser(ctx, "contactHandles", userId),
      contactsDeleted: await deleteAllByUser(ctx, "contacts", userId),
      actionsDeleted: await deleteAllByUser(ctx, "actions", userId),
      integrationsReset: 0,
    };

    // Reset integration sync states
    const integrations = await ctx.db
      .query("integrations")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    for (const integration of integrations) {
      await ctx.db.patch(integration._id, {
        syncState: {
          isConnected: false,
          lastSyncCursor: "0",
          lastSyncAt: undefined,
          lastError: undefined,
          totalMessagesSynced: 0,
          totalContactsSynced: 0,
          syncVersion: 0,
          lastContactsSyncAt: undefined,
        },
      });
      stats.integrationsReset++;
    }

    return { success: true, stats };
  },
});
