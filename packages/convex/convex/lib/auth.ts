import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Find user by WorkOS ID (subject from auth identity).
 */
export function findUserByWorkosId(
  ctx: QueryCtx | MutationCtx,
  workosUserId: string
): Promise<Doc<"users"> | null> {
  return ctx.db
    .query("users")
    .withIndex("by_workos_id", (q) => q.eq("workosUserId", workosUserId))
    .unique();
}

/**
 * Get the authenticated user from context.
 * Returns null if not authenticated or user not found.
 */
export async function getAuthenticatedUser(
  ctx: QueryCtx | MutationCtx
): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return findUserByWorkosId(ctx, identity.subject);
}

/**
 * Get authenticated user or throw.
 * Use in mutations that require authentication.
 */
export async function requireAuthenticatedUser(
  ctx: MutationCtx
): Promise<Doc<"users">> {
  const user = await getAuthenticatedUser(ctx);
  if (!user) {
    throw new Error("Unauthorized");
  }
  return user;
}
