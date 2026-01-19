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

// Check if a string looks like a chat ID (hex string, UUID-like, numeric, or chat prefix)
function looksLikeChatId(name: string): boolean {
  if (!name) return false;
  // Hex string (16+ chars of hex)
  if (/^[a-f0-9]{16,}$/i.test(name)) return true;
  // UUID-like
  if (/^[a-f0-9-]{32,}$/i.test(name)) return true;
  // Pure numeric (6+ digits)
  if (/^\d{6,}$/.test(name)) return true;
  // "chat" followed by numbers (e.g., chat260155555961895917)
  if (/^chat\d+$/i.test(name)) return true;
  // chat: prefix
  if (name.startsWith("chat:")) return true;
  return false;
}

/**
 * Migration: Populate displayName for group conversations from participant names.
 * Fixes conversations that have no displayName OR have a chat ID as displayName.
 * Runs on ALL conversations across all users.
 */
export const migrateGroupDisplayNames = mutation({
  args: {},
  handler: async (ctx) => {
    // Get all conversations (no user filter)
    const conversations = await ctx.db.query("conversations").collect();

    let updated = 0;
    let skippedDm = 0;
    let skippedHasValidName = 0;
    let skippedNoParticipants = 0;

    for (const conv of conversations) {
      if (conv.conversationType === "dm") {
        skippedDm++;
        continue;
      }

      // Skip if displayName exists and doesn't look like a chat ID
      if (conv.displayName && !looksLikeChatId(conv.displayName)) {
        skippedHasValidName++;
        continue;
      }

      // Build displayName from participants
      const participants = await Promise.all(
        conv.participantContactIds.map((id) => ctx.db.get(id))
      );
      const names = participants
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .map((p) => p.displayName)
        .filter(Boolean);

      if (names.length > 0) {
        await ctx.db.patch(conv._id, { displayName: names.join(", ") });
        updated++;
      } else {
        skippedNoParticipants++;
      }
    }

    return { updated, skippedDm, skippedHasValidName, skippedNoParticipants, total: conversations.length };
  },
});

/**
 * Migration: Remove deprecated draftMessage field from actions.
 * After running this, you can remove draftMessage from the schema.
 */
export const migrateRemoveDraftMessage = mutation({
  args: {},
  handler: async (ctx) => {
    const actions = await ctx.db.query("actions").collect();

    let updated = 0;
    for (const action of actions) {
      // Check if the action has the deprecated field
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((action as any).draftMessage !== undefined) {
        // Use unset by setting to undefined and replacing the document
        const { draftMessage: _, ...rest } = action as typeof action & { draftMessage?: string };
        await ctx.db.replace(action._id, rest);
        updated++;
      }
    }

    return { updated, total: actions.length };
  },
});
