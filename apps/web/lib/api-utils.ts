/**
 * Shared API utilities for Next.js API routes.
 * Reduces duplication across sync and other API endpoints.
 */
import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { env } from "@cued/env/server";

/**
 * Create a Convex HTTP client.
 * Uses the NEXT_PUBLIC_CONVEX_URL environment variable.
 */
export function getConvexClient(): ConvexHttpClient {
  return new ConvexHttpClient(env.NEXT_PUBLIC_CONVEX_URL!);
}

/**
 * Extract Bearer token from Authorization header.
 * Returns null if header is missing or malformed.
 */
export function extractBearerToken(request: NextRequest): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

/**
 * Check if an error message indicates an authentication failure.
 */
export function isAuthError(message: string): boolean {
  const lowerMessage = message.toLowerCase();
  return (
    lowerMessage.includes("unauthorized") ||
    lowerMessage.includes("auth") ||
    lowerMessage.includes("unauthenticated")
  );
}

/** Error response body type */
export interface ErrorResponseBody {
  error: string;
  details?: string;
}

/**
 * Extract error message from unknown error.
 */
export function extractErrorMessage(error: unknown, fallback = "Unknown error"): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return fallback;
}

/**
 * Create an authenticated Convex client from a request.
 * Returns error response if auth header is missing.
 */
export function getAuthenticatedConvexClient(
  request: NextRequest
): { convex: ConvexHttpClient; token: string } | { error: NextResponse } {
  const token = extractBearerToken(request);
  if (!token) {
    return {
      error: NextResponse.json<ErrorResponseBody>(
        { error: "Missing or invalid Authorization header" },
        { status: 401 }
      ),
    };
  }

  const convex = getConvexClient();
  convex.setAuth(token);
  return { convex, token };
}

/**
 * Wrapper for API handlers that require authentication.
 * Handles auth extraction and common error patterns.
 */
export async function withAuth<T>(
  request: NextRequest,
  handler: (convex: ConvexHttpClient, token: string) => Promise<T>
): Promise<NextResponse<T | ErrorResponseBody>> {
  const result = getAuthenticatedConvexClient(request);
  if ("error" in result) {
    return result.error as NextResponse<T | ErrorResponseBody>;
  }

  try {
    const data = await handler(result.convex, result.token);
    return NextResponse.json<T>(data);
  } catch (error) {
    const message = extractErrorMessage(error, "Request failed");
    if (isAuthError(message)) {
      return NextResponse.json<ErrorResponseBody>(
        { error: "Authentication failed", details: message },
        { status: 401 }
      ) as NextResponse<T | ErrorResponseBody>;
    }
    console.error("API error:", error);
    return NextResponse.json<ErrorResponseBody>(
      { error: "Request failed", details: message },
      { status: 500 }
    ) as NextResponse<T | ErrorResponseBody>;
  }
}
