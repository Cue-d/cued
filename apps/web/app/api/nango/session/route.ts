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

function errorResponse(error: string, status: number, details?: string): NextResponse {
  return NextResponse.json(details ? { error, details } : { error }, { status });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = extractBearerToken(request);
  if (!token) {
    return errorResponse("Missing or invalid Authorization header", 401);
  }

  try {
    convex.setAuth(token);
    const identity = await convex.query(api.users.getCurrentUser, {});
    if (!identity) {
      return errorResponse("User not found", 401);
    }

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
        ...(identity.name && { display_name: identity.name }),
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
    return errorResponse("Failed to create connect session", 500, message);
  }
}
