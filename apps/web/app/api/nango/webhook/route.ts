import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@prm/convex";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

interface NangoWebhookPayload {
  type: string;
  operation: string;
  success?: boolean;
  connectionId?: string;
  providerConfigKey?: string;
  endUser?: {
    endUserId: string;
    endUserEmail?: string;
  };
}

/**
 * POST /api/nango/webhook
 * Handles Nango webhooks for connection creation/deletion.
 * Configure this URL in Nango Dashboard > Environment Settings > Webhooks.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const payload = (await request.json()) as NangoWebhookPayload;

    // Only process auth events
    if (payload.type !== "auth") {
      return NextResponse.json({ received: true, processed: false });
    }

    const { operation, connectionId, providerConfigKey, endUser, success } = payload;

    // Validate required fields
    if (!endUser?.endUserId || !providerConfigKey) {
      console.error("Nango webhook missing required fields:", payload);
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed";
    console.error("Nango webhook error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
