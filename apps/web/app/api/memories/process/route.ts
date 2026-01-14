/**
 * Task 3.13b: Batch memory processing endpoint.
 *
 * POST /api/memories/process
 * Processes a batch of messages to extract memories using Mem0.
 *
 * This endpoint can be called:
 * 1. Manually for initial backfill
 * 2. Via Vercel cron for scheduled processing
 * 3. Via external scheduler
 *
 * Rate limiting: Processes ~50 messages per call.
 * For 148k messages at 5-minute intervals, full backfill takes ~24 hours.
 */
import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@prm/convex";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export async function POST(req: Request) {
  // Get auth token from header
  const token = req.headers.get("authorization")?.replace("Bearer ", "");

  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  convex.setAuth(token);

  // Parse optional platform from body (defaults to "imessage")
  let platform: "imessage" | "gmail" | "slack" = "imessage";
  try {
    const body = await req.json().catch(() => ({}));
    if (body.platform && ["imessage", "gmail", "slack"].includes(body.platform)) {
      platform = body.platform;
    }
  } catch {
    // Use default platform
  }

  try {
    // Call the Convex action to process a batch
    const result = await convex.action(api.memories.processMemoryBatch, {
      platform,
    });

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error("Error processing memory batch:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/memories/process
 * Returns the current memory processing status.
 */
export async function GET(req: Request) {
  // Get auth token from header
  const token = req.headers.get("authorization")?.replace("Bearer ", "");

  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  convex.setAuth(token);

  // Parse optional platform from query (defaults to "imessage")
  const url = new URL(req.url);
  const platformParam = url.searchParams.get("platform");
  const platform =
    platformParam && ["imessage", "gmail", "slack"].includes(platformParam)
      ? (platformParam as "imessage" | "gmail" | "slack")
      : "imessage";

  try {
    const status = await convex.query(api.memories.getMemoryProcessingStatus, {
      platform,
    });

    if (!status) {
      return NextResponse.json({ error: "Not authenticated or no data" }, { status: 401 });
    }

    const progress = status.totalMessages > 0
      ? Math.round((status.totalMessagesProcessed / status.totalMessages) * 100)
      : 0;

    return NextResponse.json({
      ...status,
      progress,
      isComplete: status.totalMessagesProcessed >= status.totalMessages,
    });
  } catch (error) {
    console.error("Error getting memory processing status:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
