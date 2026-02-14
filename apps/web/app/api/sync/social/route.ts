import { NextRequest, NextResponse } from "next/server";
import { api } from "@cued/convex";
import type { ActionPlatform } from "@cued/shared";
import {
  extractBearerToken,
  extractErrorMessage,
  isAuthError,
  getConvexClient,
} from "@/lib/api-utils";

// Types for social sync batch
export type SocialPlatform = Extract<ActionPlatform, "linkedin" | "twitter">;

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

/**
 * POST /api/sync/social - Receive social contacts batch and forward to Convex.
 *
 * Request body: SocialSyncBatch
 * Response: SocialSyncResult
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = extractBearerToken(request);
  if (!token) {
    return NextResponse.json({ error: "Missing or invalid Authorization header" }, { status: 401 });
  }

  let batch: SocialSyncBatch;
  try {
    batch = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Validate platform
  if (!batch.platform || !["linkedin", "twitter"].includes(batch.platform)) {
    return NextResponse.json(
      { error: 'Missing or invalid platform field. Must be "linkedin" or "twitter"' },
      { status: 400 }
    );
  }

  // Validate contacts array
  if (!Array.isArray(batch.contacts)) {
    return NextResponse.json({ error: "Missing or invalid contacts array" }, { status: 400 });
  }

  // Validate each contact (per-platform requirements)
  for (let i = 0; i < batch.contacts.length; i++) {
    const contact = batch.contacts[i];
    if (!contact.name || typeof contact.name !== "string") {
      return NextResponse.json({ error: `Contact at index ${i} missing valid name` }, { status: 400 });
    }
    if (!contact.platform || contact.platform !== batch.platform) {
      return NextResponse.json(
        { error: `Contact at index ${i} has mismatched platform` },
        { status: 400 }
      );
    }
    if (batch.platform === "linkedin") {
      if (!contact.profileUrl || typeof contact.profileUrl !== "string") {
        return NextResponse.json({ error: `Contact at index ${i} missing valid profileUrl` }, { status: 400 });
      }
    } else if (batch.platform === "twitter") {
      if (!contact.handle || typeof contact.handle !== "string") {
        return NextResponse.json({ error: `Contact at index ${i} missing valid handle` }, { status: 400 });
      }
    }
  }

  // Validate syncedAt timestamp
  if (typeof batch.syncedAt !== "number" || batch.syncedAt <= 0) {
    return NextResponse.json({ error: "Missing or invalid syncedAt timestamp" }, { status: 400 });
  }

  const convex = getConvexClient();

  try {
    convex.setAuth(token);

    let result;
    if (batch.platform === "linkedin") {
      result = await convex.mutation(api.sync.syncLinkedInContacts, {
        contacts: batch.contacts.map((c) => ({
          name: c.name,
          profileUrl: c.profileUrl,
          headline: c.headline,
          profileId: c.profileId,
        })),
      });
    } else {
      result = await convex.mutation(api.sync.syncTwitterContacts, {
        contacts: batch.contacts.map((c) => ({
          name: c.name,
          handle: c.handle,
          bio: c.headline,
        })),
      });
    }

    return NextResponse.json(result);
  } catch (error) {
    const message = extractErrorMessage(error, "Sync failed");
    if (isAuthError(message)) {
      return NextResponse.json({ error: "Authentication failed", details: message }, { status: 401 });
    }
    console.error("Social sync error:", error);
    return NextResponse.json({ error: "Social sync failed", details: message }, { status: 500 });
  }
}
