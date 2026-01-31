import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

// TypeScript types to break circular inference
interface ConnectNangoResult {
  integrationId: Id<"integrations">;
  updated: boolean;
}

interface DisconnectNangoResult {
  success: boolean;
  error?: string;
}

// ============================================================================
// Auth Webhook Handlers
// ============================================================================

/**
 * Handle OAuth connection creation from Nango webhook.
 * Creates or updates integration record.
 */
export const handleAuthCreation = internalMutation({
  args: {
    workosUserId: v.string(),
    providerConfigKey: v.string(),
    connectionId: v.string(),
    email: v.optional(v.string()),
  },
  returns: v.object({
    integrationId: v.id("integrations"),
    updated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    // Use existing connectNango mutation logic (explicit type to break circular inference)
    const result: ConnectNangoResult = await ctx.runMutation(api.integrations.connectNango, {
      workosUserId: args.workosUserId,
      nangoIntegrationId: args.providerConfigKey,
      nangoConnectionId: args.connectionId,
      email: args.email,
    });
    return result;
  },
});

/**
 * Handle OAuth connection deletion from Nango webhook.
 */
export const handleAuthDeletion = internalMutation({
  args: {
    workosUserId: v.string(),
    connectionId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    // Explicit type to break circular inference
    const result: DisconnectNangoResult = await ctx.runMutation(api.integrations.disconnectNango, {
      workosUserId: args.workosUserId,
      nangoConnectionId: args.connectionId,
    });
    return result;
  },
});

// ============================================================================
// Retry Logic
// ============================================================================

const RETRY_DELAYS_MS = [
  2 * 60 * 1000, // 2 minutes
  4 * 60 * 1000, // 4 minutes
  8 * 60 * 1000, // 8 minutes
];
const MAX_RETRY_ATTEMPTS = 3;

/**
 * Log sync failure and optionally schedule retry.
 */
export const logSyncFailure = internalMutation({
  args: {
    workosUserId: v.string(),
    connectionId: v.string(),
    handler: v.string(),
    error: v.string(),
    attemptNumber: v.number(),
  },
  handler: async (ctx, args) => {
    console.error(`[Nango] Sync failure for ${args.handler}:`, {
      workosUserId: args.workosUserId,
      connectionId: args.connectionId,
      error: args.error,
      attempt: args.attemptNumber,
    });

    // Schedule retry if under max attempts
    if (args.attemptNumber < MAX_RETRY_ATTEMPTS) {
      const delayMs = RETRY_DELAYS_MS[args.attemptNumber - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];

      console.log(`[Nango] Scheduling retry ${args.attemptNumber + 1} in ${delayMs / 1000}s`);

      await ctx.scheduler.runAfter(delayMs, internal.nango.retrySyncHandler, {
        workosUserId: args.workosUserId,
        connectionId: args.connectionId,
        handler: args.handler,
        attemptNumber: args.attemptNumber + 1,
      });
    } else {
      console.error(`[Nango] Max retry attempts (${MAX_RETRY_ATTEMPTS}) reached for ${args.handler}`);
    }
  },
});
