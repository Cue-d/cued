import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { findUserByWorkosId } from "./lib/auth";

/**
 * Get the current authenticated user's identity from JWT.
 * Returns basic auth info - use getProfile for full user data.
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
    };
  },
});

/**
 * Get the current user's full profile from database.
 */
export const getProfile = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const user = await findUserByWorkosId(ctx, identity.subject);
    if (!user) return null;

    return {
      id: user._id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      profilePictureUrl: user.profilePictureUrl,
    };
  },
});

/**
 * Sync user profile from WorkOS user data.
 * Creates user if not exists, updates profile if changed.
 * Call this on app startup with user data from AuthKit/token response.
 */
export const syncProfile = mutation({
  args: {
    email: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    profilePictureUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized");
    }

    const existing = await findUserByWorkosId(ctx, identity.subject);

    if (existing) {
      // Build updates object with only changed fields
      const fields = ["email", "firstName", "lastName", "profilePictureUrl"] as const;
      const updates: Record<string, string> = {};

      for (const field of fields) {
        const newValue = args[field];
        if (newValue && newValue !== existing[field]) {
          updates[field] = newValue;
        }
      }

      if (Object.keys(updates).length > 0) {
        await ctx.db.patch(existing._id, updates);
      }

      return {
        id: existing._id,
        email: updates.email ?? existing.email,
        firstName: updates.firstName ?? existing.firstName,
        lastName: updates.lastName ?? existing.lastName,
      };
    }

    // Create new user
    const userId = await ctx.db.insert("users", {
      workosUserId: identity.subject,
      email: args.email ?? "",
      firstName: args.firstName,
      lastName: args.lastName,
      profilePictureUrl: args.profilePictureUrl,
    });

    return {
      id: userId,
      email: args.email ?? "",
      firstName: args.firstName,
      lastName: args.lastName,
    };
  },
});
