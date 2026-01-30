import { NextRequest, NextResponse } from "next/server";
import { Nango } from "@nangohq/node";
import { api } from "@cued/convex";
import { env } from "@cued/env/server";
import { extractBearerToken, getConvexClient } from "@/lib/api-utils";

const nango = new Nango({ secretKey: env.NANGO_SECRET_KEY });

export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = extractBearerToken(request);
  if (!token) {
    return NextResponse.json({ error: "Missing or invalid Authorization header" }, { status: 401 });
  }

  const convex = getConvexClient();

  try {
    convex.setAuth(token);
    const identity = await convex.query(api.users.getCurrentUser, {});
    if (!identity) {
      return NextResponse.json({ error: "User not found" }, { status: 401 });
    }

    // Get user profile for display name
    const profile = await convex.query(api.users.getProfile, {});
    const displayName = profile?.firstName && profile?.lastName
      ? `${profile.firstName} ${profile.lastName}`
      : profile?.firstName ?? profile?.lastName;

    let allowedIntegrations: string[] | undefined;
    try {
      const body = await request.json();
      allowedIntegrations = body.allowed_integrations;
    } catch {
      // Empty body is fine
    }

    const response = await nango.createConnectSession({
      end_user: {
        id: identity.subject,
        ...(identity.email && { email: identity.email }),
        ...(displayName && { display_name: displayName }),
      },
      ...(allowedIntegrations && { allowed_integrations: allowedIntegrations }),
    });

    return NextResponse.json({
      sessionToken: response.data.token,
    });
  } catch (error) {
    // Extract error details from Axios response if available
    let message = "Session creation failed";
    if (error && typeof error === "object" && "response" in error) {
      const axiosError = error as { response?: { data?: { error?: { message?: string } } } };
      message = axiosError.response?.data?.error?.message ?? message;
    } else if (error instanceof Error) {
      message = error.message;
    }
    console.error("Nango session error:", message);
    return NextResponse.json({ error: "Failed to create connect session", details: message }, { status: 500 });
  }
}
