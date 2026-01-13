import { NextRequest, NextResponse } from "next/server"
import { ConvexHttpClient } from "convex/browser"
import { api } from "@prm/convex"
import type { SyncBatch, SyncResult } from "@prm/integrations/imessage"

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!)

/**
 * POST /api/sync/imessage
 *
 * Receives iMessage sync batches from Electron app and forwards to Convex.
 *
 * Headers:
 *   Authorization: Bearer <workos_access_token>
 *
 * Body:
 *   SyncBatch from @prm/integrations
 *
 * Returns:
 *   SyncResult with cursor, counts, and errors
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Extract auth token from Authorization header
  const authHeader = request.headers.get("Authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: "Missing or invalid Authorization header" },
      { status: 401 }
    )
  }

  const token = authHeader.slice(7) // Remove "Bearer " prefix

  // Parse request body
  let batch: SyncBatch
  try {
    batch = await request.json()
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    )
  }

  // Validate required fields
  if (typeof batch.cursor !== "number") {
    return NextResponse.json(
      { error: "Missing or invalid cursor field" },
      { status: 400 }
    )
  }

  if (!Array.isArray(batch.chats) || !Array.isArray(batch.messages)) {
    return NextResponse.json(
      { error: "Missing or invalid chats/messages arrays" },
      { status: 400 }
    )
  }

  try {
    // Set auth token for Convex request
    convex.setAuth(token)

    // Call Convex mutation with batch
    const result = (await convex.mutation(api.sync.syncMessages, {
      batch,
    })) as SyncResult

    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed"

    // Check for auth errors
    if (message.includes("Unauthorized") || message.includes("auth")) {
      return NextResponse.json(
        { error: "Authentication failed", details: message },
        { status: 401 }
      )
    }

    console.error("Sync error:", error)
    return NextResponse.json(
      { error: "Sync failed", details: message },
      { status: 500 }
    )
  }
}
