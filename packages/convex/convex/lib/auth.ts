import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Find user by WorkOS ID (subject from auth identity).
 */
export function findUserByWorkosId(
  ctx: QueryCtx | MutationCtx,
  workosUserId: string
): Promise<Doc<"users"> | null> {
  return (async () => {
    const users = await ctx.db
      .query("users")
      .withIndex("by_workos_id", (q) => q.eq("workosUserId", workosUserId))
      .collect();

    if (users.length === 0) return null;
    if (users.length === 1) return users[0];

    // Guard against duplicate rows for the same WorkOS subject.
    // Choose the oldest user as canonical to preserve existing linked data.
    const canonical = users.reduce((oldest, current) =>
      current._creationTime < oldest._creationTime ? current : oldest
    );

    console.error("[Auth] Duplicate users found for workosUserId; using canonical user", {
      workosUserId,
      count: users.length,
      canonicalUserId: canonical._id,
      duplicateUserIds: users.map((user) => user._id),
    });

    return canonical;
  })();
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
