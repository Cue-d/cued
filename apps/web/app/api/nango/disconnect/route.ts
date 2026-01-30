import { NextRequest, NextResponse } from "next/server";
import { Nango } from "@nangohq/node";
import { api } from "@cued/convex";
import { env } from "@cued/env/server";
import { getAuthenticatedConvexClient } from "@/lib/api-utils";

const nango = new Nango({ secretKey: env.NANGO_SECRET_KEY });

export async function POST(request: NextRequest) {
  const authResult = getAuthenticatedConvexClient(request);
  if ("error" in authResult) return authResult.error;
  const { convex } = authResult;

  try {
    // Get user from Convex
    const identity = await convex.query(api.users.getCurrentUser, {});
    if (!identity) {
      return NextResponse.json({ error: "User not found" }, { status: 401 });
    }

    const { nangoConnectionId, providerConfigKey } = await request.json();

    if (!nangoConnectionId || !providerConfigKey) {
      return NextResponse.json({ error: "Missing nangoConnectionId or providerConfigKey" }, { status: 400 });
    }

    console.log("Attempting to delete Nango connection:", {
      providerConfigKey,
      nangoConnectionId,
    });

    // Delete the connection from Nango
    // If this fails (connection doesn't exist, wrong name, etc.), continue anyway
    try {
      await nango.deleteConnection(providerConfigKey, nangoConnectionId);
      console.log("Nango connection deleted successfully");
    } catch (nangoError) {
      // Log but don't fail - connection might already be deleted or name mismatch
      console.warn("Nango deleteConnection failed (continuing anyway):", nangoError);
    }

    // Update Convex to mark as disconnected
    await convex.mutation(api.integrations.disconnectNango, {
      workosUserId: identity.subject,
      nangoConnectionId,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to disconnect:", error);
    return NextResponse.json({ error: "Failed to disconnect integration" }, { status: 500 });
  }
}
