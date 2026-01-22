/**
 * File storage mutations for attachment uploads.
 *
 * Provides upload URL generation and file URL retrieval.
 */

import { v } from "convex/values";
import { mutation } from "./_generated/server";

/**
 * Generate an upload URL for a file.
 * The URL expires in 1 hour and should be used shortly after generation.
 */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to upload files");
    }

    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Generate multiple upload URLs for batch uploads.
 * Returns an array of upload URLs.
 */
export const generateUploadUrls = mutation({
  args: {
    count: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to upload files");
    }

    if (args.count < 1 || args.count > 20) {
      throw new Error("Count must be between 1 and 20");
    }

    return Promise.all(
      Array.from({ length: args.count }, () => ctx.storage.generateUploadUrl())
    );
  },
});

