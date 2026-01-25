import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@prm/convex";
import { env } from "@prm/env/server";

const convex = new ConvexHttpClient(env.NEXT_PUBLIC_CONVEX_URL!);

// Types for social sync batch
export type SocialPlatform = "linkedin" | "twitter";

export interface SocialContact {
  name: string;
  handle: string; // LinkedIn URL or Twitter handle
  profileUrl: string;
  headline: string | null;
  platform: SocialPlatform;
  /** LinkedIn profile ID (URN ID portion) for matching with messaging contacts */
  profileId?: string;
}

export interface SocialSyncBatch {
  platform: SocialPlatform;
  contacts: SocialContact[];
  syncedAt: number; // Unix timestamp
}

export interface SocialSyncResult {
  totalContacts: number;
  newContacts: number;
  updatedContacts: number;
}

function extractBearerToken(request: NextRequest): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

function isAuthError(message: string): boolean {
  return message.includes("Unauthorized") || message.includes("auth");
}

function errorResponse(
  error: string,
  status: number,
  details?: string
): NextResponse {
  return NextResponse.json(details ? { error, details } : { error }, {
    status,
  });
}

/**
 * POST /api/sync/social - Receive social contacts batch and forward to Convex.
 *
 * Request body: SocialSyncBatch
 * Response: SocialSyncResult
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = extractBearerToken(request);
  if (!token) {
    return errorResponse("Missing or invalid Authorization header", 401);
  }

  let batch: SocialSyncBatch;
  try {
    batch = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  // Validate platform
  if (!batch.platform || !["linkedin", "twitter"].includes(batch.platform)) {
    return errorResponse(
      'Missing or invalid platform field. Must be "linkedin" or "twitter"',
      400
    );
  }

  // Validate contacts array
  if (!Array.isArray(batch.contacts)) {
    return errorResponse("Missing or invalid contacts array", 400);
  }

  // Validate each contact
  for (let i = 0; i < batch.contacts.length; i++) {
    const contact = batch.contacts[i];
    if (!contact.name || typeof contact.name !== "string") {
      return errorResponse(`Contact at index ${i} missing valid name`, 400);
    }
    if (!contact.handle || typeof contact.handle !== "string") {
      return errorResponse(`Contact at index ${i} missing valid handle`, 400);
    }
    if (!contact.profileUrl || typeof contact.profileUrl !== "string") {
      return errorResponse(`Contact at index ${i} missing valid profileUrl`, 400);
    }
    if (!contact.platform || contact.platform !== batch.platform) {
      return errorResponse(
        `Contact at index ${i} has mismatched platform`,
        400
      );
    }
  }

  // Validate syncedAt timestamp
  if (typeof batch.syncedAt !== "number" || batch.syncedAt <= 0) {
    return errorResponse("Missing or invalid syncedAt timestamp", 400);
  }

  try {
    convex.setAuth(token);

    const result = await convex.mutation(api.sync.syncSocialContacts, {
      platform: batch.platform,
      contacts: batch.contacts.map((c) => ({
        name: c.name,
        handle: c.handle,
        profileUrl: c.profileUrl,
        headline: c.headline,
        profileId: c.profileId,
      })),
      syncedAt: batch.syncedAt,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed";
    if (isAuthError(message)) {
      return errorResponse("Authentication failed", 401, message);
    }
    console.error("Social sync error:", error);
    return errorResponse("Social sync failed", 500, message);
  }
}
