import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@prm/convex";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

interface NangoWebhookPayload {
  type: string; // "auth" | "sync"
  operation: string;
  success?: boolean;
  connectionId?: string;
  providerConfigKey?: string;
  endUser?: {
    endUserId: string;
    endUserEmail?: string;
  };
  // Sync-specific fields
  model?: string;
  queryTimeStamp?: string;
  modifiedAfter?: string;
  syncName?: string;
}

/**
 * POST /api/nango/webhook
 * Handles Nango webhooks for connection and sync events.
 * Configure this URL in Nango Dashboard > Environment Settings > Webhooks.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const payload = (await request.json()) as NangoWebhookPayload;
    const { type } = payload;

    console.log("Nango webhook received:", { type, operation: payload.operation, providerConfigKey: payload.providerConfigKey });

    // Handle sync events
    if (type === "sync") {
      return handleSyncWebhook(payload);
    }

    // Handle auth events
    if (type === "auth") {
      return handleAuthWebhook(payload);
    }

    // Unknown type - acknowledge but don't process
    return NextResponse.json({ received: true, processed: false, reason: "Unknown type" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed";
    console.error("Nango webhook error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Handle auth webhooks (connection creation/deletion)
 */
async function handleAuthWebhook(payload: NangoWebhookPayload): Promise<NextResponse> {
  const { operation, connectionId, providerConfigKey, endUser, success } = payload;

  // Validate required fields
  if (!endUser?.endUserId || !providerConfigKey) {
    console.error("Nango auth webhook missing required fields:", payload);
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Handle connection creation
  if (operation === "creation" && success && connectionId) {
    const result = await convex.mutation(api.integrations.connectNango, {
      workosUserId: endUser.endUserId,
      nangoIntegrationId: providerConfigKey,
      nangoConnectionId: connectionId,
      email: endUser.endUserEmail,
    });
    console.log("Nango connection created:", result);
    return NextResponse.json({ received: true, processed: true, result });
  }

  // Handle connection deletion
  if (operation === "deletion" && connectionId) {
    const result = await convex.mutation(api.integrations.disconnectNango, {
      workosUserId: endUser.endUserId,
      nangoConnectionId: connectionId,
    });
    console.log("Nango connection deleted:", result);
    return NextResponse.json({ received: true, processed: true, result });
  }

  // Other operations (refresh, etc.) - acknowledge but don't process
  return NextResponse.json({ received: true, processed: false });
}

/**
 * Handle sync webhooks (sync completion)
 */
async function handleSyncWebhook(payload: NangoWebhookPayload): Promise<NextResponse> {
  const { operation, connectionId, providerConfigKey, endUser, success } = payload;

  // Only process successful syncs
  if (!success || operation !== "success") {
    return NextResponse.json({ received: true, processed: false, reason: "Sync not successful" });
  }

  // Validate required fields
  if (!connectionId || !providerConfigKey || !endUser?.endUserId) {
    console.error("Nango sync webhook missing required fields:", payload);
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Route to appropriate pull handler based on integration
  if (providerConfigKey === "slack") {
    // Call our pull-slack endpoint to fetch and sync records
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const pullResponse = await fetch(`${baseUrl}/api/nango/pull-slack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connectionId,
        workosUserId: endUser.endUserId,
      }),
    });

    if (!pullResponse.ok) {
      const error = await pullResponse.json();
      console.error("Slack pull failed:", error);
      return NextResponse.json({ received: true, processed: false, error });
    }

    const result = await pullResponse.json();
    console.log("Slack sync pulled:", result);
    return NextResponse.json({ received: true, processed: true, result });
  }

  // TODO: Add google-mail handler here

  return NextResponse.json({ received: true, processed: false, reason: "Unknown integration" });
}
