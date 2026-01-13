import { NextRequest, NextResponse } from "next/server"
import { ConvexHttpClient } from "convex/browser"
import { api } from "@prm/convex"
import type { SyncBatch, SyncResult } from "@prm/integrations/imessage"

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!)

function extractBearerToken(request: NextRequest): string | null {
  const authHeader = request.headers.get("Authorization")
  if (!authHeader?.startsWith("Bearer ")) return null
  return authHeader.slice(7)
}

function isAuthError(message: string): boolean {
  return message.includes("Unauthorized") || message.includes("auth")
}

function errorResponse(
  error: string,
  status: number,
  details?: string
): NextResponse {
  return NextResponse.json(
    details ? { error, details } : { error },
    { status }
  )
}

/**
 * GET /api/sync/imessage - Fetch current sync cursor from Convex.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = extractBearerToken(request)
  if (!token) {
    return errorResponse("Missing or invalid Authorization header", 401)
  }

  try {
    convex.setAuth(token)
    const result = await convex.query(api.sync.getSyncCursor, {
      platform: "imessage",
    })

    if (!result) {
      return errorResponse("Authentication failed", 401)
    }

    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Query failed"
    if (isAuthError(message)) {
      return errorResponse("Authentication failed", 401, message)
    }
    console.error("Cursor fetch error:", error)
    return errorResponse("Failed to fetch cursor", 500, message)
  }
}

/**
 * POST /api/sync/imessage - Receive iMessage sync batches and forward to Convex.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = extractBearerToken(request)
  if (!token) {
    return errorResponse("Missing or invalid Authorization header", 401)
  }

  let batch: SyncBatch
  try {
    batch = await request.json()
  } catch {
    return errorResponse("Invalid JSON body", 400)
  }

  if (typeof batch.cursor !== "number") {
    return errorResponse("Missing or invalid cursor field", 400)
  }

  if (!Array.isArray(batch.chats) || !Array.isArray(batch.messages)) {
    return errorResponse("Missing or invalid chats/messages arrays", 400)
  }

  try {
    convex.setAuth(token)
    const result = (await convex.mutation(api.sync.syncMessages, {
      batch,
    })) as SyncResult

    await convex.mutation(api.sync.updateSyncCursor, {
      platform: "imessage",
      cursor: String(result.cursor),
    })

    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed"
    if (isAuthError(message)) {
      return errorResponse("Authentication failed", 401, message)
    }
    console.error("Sync error:", error)
    return errorResponse("Sync failed", 500, message)
  }
}
