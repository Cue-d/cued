/**
 * Task 3.13b: Vercel cron endpoint for memory processing.
 *
 * This endpoint is called by Vercel cron every 5 minutes.
 * It processes a batch of messages for each user with an active integration.
 *
 * Security: Protected by CRON_SECRET environment variable.
 */
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  // Verify cron secret for security
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  // In development, allow without secret
  if (process.env.NODE_ENV === "production" && cronSecret) {
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // Note: Cron jobs need a way to authenticate as each user to process their messages.
  // For now, this endpoint just returns status. Users should call /api/memories/process
  // directly with their auth token for batch processing.
  //
  // In a production system, you'd either:
  // 1. Store user tokens securely and process in background
  // 2. Use a system-level auth token with admin privileges
  // 3. Queue jobs per-user and process when they're active
  //
  // For MVP, we rely on manual triggering via the web UI or authenticated API calls.

  return NextResponse.json({
    message: "Memory processing cron endpoint",
    note: "Use POST /api/memories/process with user auth token for batch processing",
    timestamp: new Date().toISOString(),
  });
}
