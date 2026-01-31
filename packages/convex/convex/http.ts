import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

/**
 * POST /nango/webhook
 *
 * Handles Nango webhooks for connection and sync events.
 * Verifies signature before processing.
 *
 * Configure webhook URL in Nango Dashboard:
 * https://<deployment>.convex.site/nango/webhook
 */
http.route({
  path: "/nango/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const signature = request.headers.get("x-nango-signature");
    const rawBody = await request.text();

    // Verify signature using Node.js action (Nango SDK requires Node)
    const isValid = await ctx.runAction(internal.nango.verifyWebhookSignature, {
      signature: signature ?? "",
      rawBody,
    });

    if (!isValid) {
      console.error("Nango webhook signature verification failed");
      return new Response(JSON.stringify({ error: "Invalid signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Parse payload
    let payload: NangoWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as NangoWebhookPayload;
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { type, operation } = payload;
    console.log("Nango webhook received:", {
      type,
      operation,
      providerConfigKey: payload.providerConfigKey,
    });

    // Route to appropriate handler
    if (type === "auth") {
      const result = await handleAuthWebhook(ctx, payload);
      return new Response(JSON.stringify(result), {
        status: result.error ? 400 : 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (type === "sync") {
      const result = await handleSyncWebhook(ctx, payload);
      return new Response(JSON.stringify(result), {
        status: result.error ? 400 : 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Unknown type - acknowledge but don't process
    return new Response(
      JSON.stringify({ received: true, processed: false, reason: "Unknown type" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }),
});

// ============================================================================
// Webhook Payload Types
// ============================================================================

interface NangoWebhookPayload {
  type: "auth" | "sync";
  operation: string;
  success?: boolean;
  connectionId?: string;
  providerConfigKey?: string;
  endUser?: {
    endUserId: string;
    endUserEmail?: string;
  };
  // Sync-specific fields
  syncName?: string;
  responseResults?: {
    added: number;
    updated: number;
    deleted: number;
  };
}

// ============================================================================
// Auth Webhook Handler
// ============================================================================

async function handleAuthWebhook(
  ctx: Parameters<Parameters<typeof httpAction>[0]>[0],
  payload: NangoWebhookPayload
): Promise<{ received: boolean; processed: boolean; result?: unknown; error?: string }> {
  const { operation, connectionId, providerConfigKey, endUser, success } = payload;

  // Validate required fields
  if (!endUser?.endUserId || !providerConfigKey) {
    console.error("Nango auth webhook missing required fields:", payload);
    return { received: true, processed: false, error: "Missing required fields" };
  }

  // Handle connection creation
  if (operation === "creation" && success && connectionId) {
    const result = await ctx.runMutation(internal.nangoMutations.handleAuthCreation, {
      workosUserId: endUser.endUserId,
      providerConfigKey,
      connectionId,
      email: endUser.endUserEmail ?? undefined,
    });
    console.log("Nango connection created:", result);
    return { received: true, processed: true, result };
  }

  // Handle connection deletion
  if (operation === "deletion" && connectionId) {
    const result = await ctx.runMutation(internal.nangoMutations.handleAuthDeletion, {
      workosUserId: endUser.endUserId,
      connectionId,
    });
    console.log("Nango connection deleted:", result);
    return { received: true, processed: true, result };
  }

  // Other operations (refresh, etc.) - acknowledge but don't process
  return { received: true, processed: false };
}

// ============================================================================
// Sync Webhook Handler
// ============================================================================

async function handleSyncWebhook(
  ctx: Parameters<Parameters<typeof httpAction>[0]>[0],
  payload: NangoWebhookPayload
): Promise<{
  received: boolean;
  processed: boolean;
  results?: Record<string, unknown>;
  errors?: Record<string, unknown>;
  error?: string;
  reason?: string;
}> {
  const { operation, connectionId, providerConfigKey, endUser, success } = payload;

  // Only process successful syncs
  if (!success || operation !== "success") {
    return { received: true, processed: false, reason: "Sync not successful" };
  }

  // Validate required fields
  if (!connectionId || !providerConfigKey || !endUser?.endUserId) {
    console.error("Nango sync webhook missing required fields:", payload);
    return { received: true, processed: false, error: "Missing required fields" };
  }

  // Map provider to sync handlers
  const syncHandlers: Record<string, string[]> = {
    google: ["gmail", "google-contacts"],
  };

  const handlers = syncHandlers[providerConfigKey];
  if (!handlers) {
    return { received: true, processed: false };
  }

  const results: Record<string, unknown> = {};
  const errors: Record<string, unknown> = {};

  // Run sync handlers
  for (const handler of handlers) {
    try {
      if (handler === "gmail") {
        const result = await ctx.runAction(internal.nango.pullGmailRecords, {
          connectionId,
          workosUserId: endUser.endUserId,
        });
        results[handler] = result;
      } else if (handler === "google-contacts") {
        const result = await ctx.runAction(internal.nango.pullGoogleContacts, {
          connectionId,
          workosUserId: endUser.endUserId,
        });
        results[handler] = result;
      } else {
        console.warn(`Unknown sync handler: ${handler}`);
      }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : "Unknown error";
      console.error(`${handler} sync failed:`, errorMsg);
      errors[handler] = errorMsg;

      // Log failure for retry scheduling
      await ctx.runMutation(internal.nangoMutations.logSyncFailure, {
        workosUserId: endUser.endUserId,
        connectionId,
        handler,
        error: errorMsg,
        attemptNumber: 1,
      });
    }
  }

  const hasResults = Object.keys(results).length > 0;
  const hasErrors = Object.keys(errors).length > 0;

  return {
    received: true,
    processed: hasResults,
    results: hasResults ? results : undefined,
    errors: hasErrors ? errors : undefined,
  };
}

export default http;
