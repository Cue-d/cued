import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Helper to adjust the pending action count on a user.
 * Call with delta=1 when adding a pending action, delta=-1 when removing.
 */
export async function adjustPendingActionCount(
  ctx: MutationCtx,
  userId: Id<"users">,
  delta: number
): Promise<void> {
  const user = await ctx.db.get(userId);
  if (!user) return;

  const currentCount = user.pendingActionCount ?? 0;
  const newCount = Math.max(0, currentCount + delta);
  await ctx.db.patch(userId, { pendingActionCount: newCount });
}
