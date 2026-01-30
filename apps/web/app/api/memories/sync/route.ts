/**
 * Task 3.13c: Automatic memory extraction endpoint for new messages.
 *
 * POST /api/memories/sync
 * Triggers memory extraction for newly synced messages.
 * Should be called after each sync batch completes.
 *
 * Unlike /api/memories/process (batch backfill), this endpoint:
 * - Processes smaller batches (25 messages) for faster response
 * - Uses per-message memoryExtractedAt tracking for deduplication
 * - Returns hasMore to indicate if more processing is needed
 */
import { NextRequest, NextResponse } from "next/server";
import { api } from "@cued/convex";
import {
  getAuthenticatedConvexClient,
  extractErrorMessage,
} from "@/lib/api-utils";
import type { SyncPlatform } from "@cued/shared";

// Only platforms that support memory processing
type MemoryPlatform = Extract<SyncPlatform, "imessage" | "gmail" | "slack">;
const VALID_PLATFORMS: MemoryPlatform[] = ["imessage", "gmail", "slack"];

function parsePlatform(value: unknown): MemoryPlatform {
  if (typeof value === "string" && VALID_PLATFORMS.includes(value as MemoryPlatform)) {
    return value as MemoryPlatform;
  }
  return "imessage";
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authResult = getAuthenticatedConvexClient(req);
  if ("error" in authResult) return authResult.error;
  const { convex } = authResult;

  const body = await req.json().catch(() => ({}));
  const platform = parsePlatform(body.platform);

  try {
    const result = await convex.action(api.memories.processNewMessagesForMemory, {
      platform,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error("Error processing memories for new messages:", error);
    return NextResponse.json({ error: extractErrorMessage(error) }, { status: 500 });
  }
}

/**
 * GET /api/memories/sync
 * Returns count of unprocessed messages waiting for memory extraction.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const authResult = getAuthenticatedConvexClient(req);
  if ("error" in authResult) return authResult.error;
  const { convex } = authResult;

  try {
    const status = await convex.query(api.memories.getUnprocessedMessageCount, {});
    if (!status) {
      return NextResponse.json({ error: "Not authenticated or no data" }, { status: 401 });
    }
    return NextResponse.json(status);
  } catch (error) {
    console.error("Error getting unprocessed message count:", error);
    return NextResponse.json({ error: extractErrorMessage(error) }, { status: 500 });
  }
}
