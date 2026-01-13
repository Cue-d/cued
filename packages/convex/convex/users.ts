import { query } from "./_generated/server";

/**
 * Get the current authenticated user's identity.
 * Returns user info from WorkOS JWT if authenticated.
 */
export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();

    if (!identity) {
      return null;
    }

    return {
      subject: identity.subject,
      email: identity.email,
      name: identity.name,
      emailVerified: identity.emailVerified,
    };
  },
});
