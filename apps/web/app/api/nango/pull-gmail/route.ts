import { NextRequest, NextResponse } from "next/server";
import { Nango } from "@nangohq/node";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@prm/convex";

const nango = new Nango({ secretKey: process.env.NANGO_SECRET_KEY! });
const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

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

    // Fetch records from Nango (model name must match sync definition)
    const { records } = await nango.listRecords<GmailEmail>({
      providerConfigKey: "google",
      connectionId,
      model: "GmailEmail",
    });

    if (!records || records.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No new records to sync",
        count: 0,
      });
    }

    // Sync to Convex
    const result = await convex.mutation(api.sync.syncGmailMessages, {
      workosUserId,
      emails: records,
    });

    console.log("Gmail sync complete:", {
      messages: result.messagesCount,
      conversations: result.conversationsCount,
      skipped: result.skippedNewsletters,
    });

    return NextResponse.json({
      success: true,
      result,
      recordsProcessed: records.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Pull failed";
    console.error("Gmail pull error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
