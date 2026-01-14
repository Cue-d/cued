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
import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@prm/convex";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

type Platform = "imessage" | "gmail" | "slack";
const VALID_PLATFORMS: Platform[] = ["imessage", "gmail", "slack"];

function parsePlatform(value: unknown): Platform {
  if (typeof value === "string" && VALID_PLATFORMS.includes(value as Platform)) {
    return value as Platform;
  }
  return "imessage";
}

export async function POST(req: Request): Promise<Response> {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  convex.setAuth(token);

  const body = await req.json().catch(() => ({}));
  const platform = parsePlatform(body.platform);

  try {
    const result = await convex.action(api.memories.processNewMessagesForMemory, {
      platform,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error("Error processing memories for new messages:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/memories/sync
 * Returns count of unprocessed messages waiting for memory extraction.
 */
export async function GET(req: Request): Promise<Response> {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  convex.setAuth(token);

  try {
    const status = await convex.query(api.memories.getUnprocessedMessageCount, {});
    if (!status) {
      return NextResponse.json({ error: "Not authenticated or no data" }, { status: 401 });
    }
    return NextResponse.json(status);
  } catch (error) {
    console.error("Error getting unprocessed message count:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
