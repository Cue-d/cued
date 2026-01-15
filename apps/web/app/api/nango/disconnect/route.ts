import { NextRequest, NextResponse } from "next/server";
import { Nango } from "@nangohq/node";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@prm/convex";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
const nango = new Nango({ secretKey: process.env.NANGO_SECRET_KEY! });

function extractBearerToken(request: NextRequest): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

export async function POST(request: NextRequest) {
  const token = extractBearerToken(request);
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Get user from Convex
    convex.setAuth(token);
    const identity = await convex.query(api.users.getCurrentUser, {});
    if (!identity) {
      return NextResponse.json({ error: "User not found" }, { status: 401 });
    }

    const { nangoConnectionId, providerConfigKey } = await request.json();

    if (!nangoConnectionId || !providerConfigKey) {
      return NextResponse.json(
        { error: "Missing nangoConnectionId or providerConfigKey" },
        { status: 400 }
      );
    }

    // Delete the connection from Nango
    await nango.deleteConnection(providerConfigKey, nangoConnectionId);

    // Update Convex to mark as disconnected
    await convex.mutation(api.integrations.disconnectNango, {
      workosUserId: identity.subject,
      nangoConnectionId,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to disconnect:", error);
    return NextResponse.json(
      { error: "Failed to disconnect integration" },
      { status: 500 }
    );
  }
}
