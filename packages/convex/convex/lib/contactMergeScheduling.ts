import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export const CONTACT_MERGE_CHECK_DELAY_MS = 5000;

/**
 * Schedule a delayed merge check for a user's contacts.
 *
 * Uses per-user coalescing: if a check is already scheduled for this user,
 * skip scheduling another one. The pending scan will do a full sweep that
 * covers any newly-changed contacts. This prevents hundreds of redundant
 * scheduled actions during bulk syncs.
 *
 * Coalescing is achieved by querying the _scheduled_functions system table
 * for pending scans. When scanAllContactsForMerges starts executing, its
 * state auto-transitions to "inProgress", allowing new changes to schedule
 * a follow-up scan.
 */
export async function scheduleContactMergeCheck(
  ctx: MutationCtx,
  userId: Id<"users">,
  _contactId: Id<"contacts">,
): Promise<void> {
  const pendingFunctions = await ctx.db.system
    .query("_scheduled_functions")
    .filter((q) => q.eq(q.field("state.kind"), "pending"))
    .collect();

  const alreadyScheduled = pendingFunctions.some(
    (fn) =>
      fn.name.includes("scanAllContactsForMerges") &&
      (fn.args as any)[0]?.userId === userId,
  );

  if (alreadyScheduled) {
    return;
  }

  await ctx.scheduler.runAfter(
    CONTACT_MERGE_CHECK_DELAY_MS,
    internal.contactResolution.scanAllContactsForMerges,
    { userId },
  );
}
