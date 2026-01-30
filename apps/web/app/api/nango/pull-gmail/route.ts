import { NextRequest, NextResponse } from "next/server";
import { Nango } from "@nangohq/node";
import { api } from "@prm/convex";
import { env } from "@prm/env/server";
import { extractErrorMessage, getConvexClient } from "@/lib/api-utils";

const nango = new Nango({ secretKey: env.NANGO_SECRET_KEY });

interface GmailEmail {
  id: string;
  sender: string;
  recipients?: string;
  date: string;
  subject: string;
  body?: string;
  attachments: Array<{
    filename: string;
    mimeType: string;
    size: number;
    attachmentId: string;
  }>;
  threadId: string;
  labelIds?: string[];
}

interface NangoRecord extends GmailEmail {
  _nango_metadata?: {
    cursor?: string;
    first_seen_at?: string;
    last_modified_at?: string;
    last_action?: string;
    deleted_at?: string | null;
  };
}

/**
 * POST /api/nango/pull-gmail
 * Pull Gmail emails from Nango and sync to Convex.
 *
 * Called by:
 * 1. Nango sync webhook when sync completes
 * 2. Manual trigger for testing
 *
 * Body: { connectionId: string, workosUserId: string }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { connectionId, workosUserId } = body;

    if (!connectionId || !workosUserId) {
      return NextResponse.json(
        { error: "Missing connectionId or workosUserId" },
        { status: 400 }
      );
    }

    // Get connection to extract account email for multi-account support
    const connection = await nango.getConnection("google", connectionId);
    const rawEmail = (connection?.credentials as { raw?: { email?: unknown } })?.raw?.email;
    const accountEmail = typeof rawEmail === "string" ? rawEmail : undefined;

    if (!accountEmail) {
      console.warn("Gmail connection missing account email, sync will not track multi-account state");
    }

    // Check if we have an existing cursor for incremental sync
    const convex = getConvexClient();
    let storedCursor: string | undefined;
    if (accountEmail) {
      const cursorResult = await convex.query(api.sync.getGmailCursor, {
        accountEmail,
        workosUserId, // Pass workosUserId for API route access (no auth context)
      });
      storedCursor = cursorResult?.cursorData?.nangoCursor as string | undefined;
    }

    // Fetch records from Nango (model name must match sync definition)
    // If we have a stored cursor, use it for precise incremental sync
    const { records } = await nango.listRecords<NangoRecord>({
      providerConfigKey: "google",
      connectionId,
      model: "GmailEmail",
      ...(storedCursor && { cursor: storedCursor }),
    });

    if (!records || records.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No new records to sync",
        count: 0,
      });
    }

    // Extract cursor from last record for next sync
    const lastRecord = records[records.length - 1];
    const nangoCursor = lastRecord._nango_metadata?.cursor;

    if (!nangoCursor && records.length > 0) {
      console.warn("Gmail sync: Last record missing cursor metadata, next sync may fall back to full sync");
    }

    // Strip Nango metadata before sending to Convex
    const cleanedRecords = records.map((record: NangoRecord) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _nango_metadata, ...email } = record;
      return email as GmailEmail;
    });

    // Determine sync mode: full if no stored cursor, incremental otherwise
    const syncMode = storedCursor ? "incremental" : "full";

    // Sync to Convex with account email and cursor for multi-account tracking
    const result = await convex.mutation(api.sync.syncGmailMessages, {
      workosUserId,
      emails: cleanedRecords,
      accountEmail,
      nangoCursor,
      syncMode,
    });

    console.log("Gmail sync complete:", {
      accountEmail,
      syncMode,
      messages: result.messagesCount,
      conversations: result.conversationsCount,
      skipped: result.skippedFiltered,
    });

    return NextResponse.json({
      success: true,
      result,
      recordsProcessed: records.length,
      accountEmail,
      syncMode,
    });
  } catch (error) {
    const message = extractErrorMessage(error, "Pull failed");
    console.error("Gmail pull error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
