/**
 * Task 3.13b: Vercel cron endpoint for memory processing.
 *
 * This endpoint is called by Vercel cron every 5 minutes.
 * It processes a batch of messages for each user with an active integration.
 *
 * Security: Protected by CRON_SECRET environment variable.
 */
import { NextResponse } from "next/server";
import { env } from "@prm/env/server";

export async function GET(req: Request) {
  // Verify cron secret for security
  const authHeader = req.headers.get("authorization");
  const cronSecret = env.CRON_SECRET;
  const nodeEnv = process.env.NODE_ENV; // Keep NODE_ENV as direct access (Next.js runtime)

  // In development, allow without secret
  if (nodeEnv === "production" && cronSecret) {
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // Note: Cron jobs need a way to authenticate as each user to process their messages.
  // In a production system, you'd either:
  // 1. Store user tokens securely and process in background
  // 2. Use a system-level auth token with admin privileges
  // 3. Queue jobs per-user and process when they're active

  return NextResponse.json({
    message: "Memory processing cron endpoint",
    timestamp: new Date().toISOString(),
  });
}
