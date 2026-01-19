import { NextRequest, NextResponse } from "next/server";
import { Nango } from "@nangohq/node";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@prm/convex";

const nango = new Nango({ secretKey: process.env.NANGO_SECRET_KEY! });
const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

interface SlackSyncMessage {
  id: string;
  channelId: string;
  channelType: "im" | "channel" | "group" | "mpim";
  channelName?: string; // Task 5.5: Channel name or DM partner name
  userId?: string;
  userName?: string; // Task 5.5: Sender display name
  text: string;
  ts: string;
  threadTs?: string;
  isThreadParent: boolean;
  reactions?: Array<{
    name: string;
    count: number;
    users: string[];
  }>;
  isBot: boolean;
  sentAt: string;
}

/**
 * POST /api/nango/pull-slack
 * Pull Slack messages from Nango and sync to Convex.
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
    const { records } = await nango.listRecords<SlackSyncMessage>({
      providerConfigKey: "slack",
      connectionId,
      model: "SlackSyncMessage",
    });

    if (!records || records.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No new records to sync",
        count: 0,
      });
    }

    // Strip Nango metadata before sending to Convex
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cleanedRecords = records.map((record: any) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { nango_metadata: _nango_metadata, ...message } = record;
      return message as SlackSyncMessage;
    });

    // Sync to Convex
    const result = await convex.mutation(api.sync.syncSlackMessages, {
      workosUserId,
      messages: cleanedRecords,
    });

    console.log("Slack sync result:", result);

    return NextResponse.json({
      success: true,
      result,
      recordsProcessed: records.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Pull failed";
    console.error("Slack pull error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
