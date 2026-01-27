import { NextRequest, NextResponse } from "next/server";
import { api } from "@prm/convex";
import {
  extractBearerToken,
  extractErrorMessage,
  isAuthError,
  getConvexClient,
} from "@/lib/api-utils";
import type { SyncBatch, SyncResult } from "@prm/integrations/imessage";

/**
 * GET /api/sync/imessage - Fetch current sync cursor from Convex.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = extractBearerToken(request);
  if (!token) {
    return NextResponse.json({ error: "Missing or invalid Authorization header" }, { status: 401 });
  }

  const convex = getConvexClient();

  try {
    convex.setAuth(token);
    const result = await convex.query(api.sync.getSyncCursor, {
      platform: "imessage",
    });

    if (!result) {
      return NextResponse.json({ error: "Authentication failed" }, { status: 401 });
    }

    return NextResponse.json(result);
  } catch (error) {
    const message = extractErrorMessage(error, "Query failed");
    if (isAuthError(message)) {
      return NextResponse.json({ error: "Authentication failed", details: message }, { status: 401 });
    }
    console.error("Cursor fetch error:", error);
    return NextResponse.json({ error: "Failed to fetch cursor", details: message }, { status: 500 });
  }
}

/**
 * POST /api/sync/imessage - Receive iMessage sync batches and forward to Convex.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = extractBearerToken(request);
  if (!token) {
    return NextResponse.json({ error: "Missing or invalid Authorization header" }, { status: 401 });
  }

  let batch: SyncBatch;
  try {
    batch = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof batch.cursor !== "number") {
    return NextResponse.json({ error: "Missing or invalid cursor field" }, { status: 400 });
  }

  if (!Array.isArray(batch.chats) || !Array.isArray(batch.messages)) {
    return NextResponse.json({ error: "Missing or invalid chats/messages arrays" }, { status: 400 });
  }

  const convex = getConvexClient();

  try {
    convex.setAuth(token);

    // Transform batch for Convex:
    // - Strip local attachments (attachment upload happens in Electron before sync)
    // - Convex expects UploadedAttachment[] with storage IDs, not local Attachment[]
    const syncBatch = {
      ...batch,
      messages: batch.messages.map((msg) => ({
        id: msg.id,
        chatId: msg.chatId,
        text: msg.text,
        timestamp: msg.timestamp,
        isFromMe: msg.isFromMe,
        isRead: msg.isRead,
        readAt: msg.readAt,
        hasAttachments: msg.hasAttachments,
        sender: msg.sender,
        // attachments field omitted - not yet supported
      })),
    };

    const result = (await convex.mutation(api.sync.syncMessages, {
      batch: syncBatch,
    })) as SyncResult;

    await convex.mutation(api.sync.updateSyncCursor, {
      platform: "imessage",
      cursor: String(result.cursor),
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = extractErrorMessage(error, "Sync failed");
    if (isAuthError(message)) {
      return NextResponse.json({ error: "Authentication failed", details: message }, { status: 401 });
    }
    console.error("Sync error:", error);
    return NextResponse.json({ error: "Sync failed", details: message }, { status: 500 });
  }
}
