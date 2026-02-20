import { mutation } from "./_generated/server";

// NOTE: resetAllUserData has been removed.
// Use debug.resetPlatformData action instead (accessible from /settings/debug in the web app).
// It supports platform-specific resets and is more comprehensive.

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
 * Migration: Deduplicate participantContactIds in conversations.
 * Fixes conversations that have duplicate contact IDs due to previous sync bugs.
 * Runs on ALL conversations across all users.
 */
export const deduplicateConversationParticipants = mutation({
  args: {},
  handler: async (ctx) => {
    const conversations = await ctx.db.query("conversations").collect();

    let fixed = 0;
    let alreadyClean = 0;

    for (const conv of conversations) {
      const originalIds = conv.participantContactIds ?? [];
      const uniqueIds = [...new Set(originalIds)];

      if (uniqueIds.length < originalIds.length) {
        await ctx.db.patch(conv._id, { participantContactIds: uniqueIds });
        fixed++;
        console.log(
          `[Migration] Fixed conversation ${conv._id}: ${originalIds.length} -> ${uniqueIds.length} participants`
        );
      } else {
        alreadyClean++;
      }
    }

    console.log(
      `[Migration] Deduplicate participants complete: ${fixed} fixed, ${alreadyClean} already clean`
    );
    return { fixed, alreadyClean, total: conversations.length };
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
