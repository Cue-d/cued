import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { api } from "@prm/convex";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { sendSlackMessage } from "@prm/integrations/nango";
import type { Id } from "@prm/convex";
import { env } from "@prm/env/server";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const convex = new ConvexHttpClient(env.NEXT_PUBLIC_CONVEX_URL!);

interface SendSlackMessageRequest {
  actionId: string; // Convex action ID
  workosUserId: string;
  conversationId: string;
  text: string;
  threadTs?: string; // For thread replies
}

/**
 * POST /api/slack/send
 * Send a Slack message and update action status.
 *
 * Called when completing a Slack-platform action (respond/follow_up).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // TODO: DISABLED - Comment out to prevent accidentally contacting people
  const body = (await request.json()) as SendSlackMessageRequest;
  console.log("[Slack API] DISABLED - would have sent message:", {
    conversationId: body.conversationId,
    text: body.text?.substring(0, 50) + "...",
  });
  return NextResponse.json({
    success: true,
    messageTs: "DISABLED",
    channel: "DISABLED",
  });

  // try {
  //   const body = (await request.json()) as SendSlackMessageRequest;
  //   const { workosUserId, conversationId, text, threadTs } = body;

  //   if (!workosUserId || !conversationId || !text) {
  //     return NextResponse.json(
  //       { error: "Missing required fields" },
  //       { status: 400 }
  //     );
  //   }

  //   // Get user's Slack connection from Convex
  //   const integration = await convex.query(api.integrations.getIntegration, {
  //     workosUserId,
  //     platform: "slack",
  //   });

  //   if (!integration?.nangoConnectionId) {
  //     return NextResponse.json(
  //       { error: "Slack not connected" },
  //       { status: 400 }
  //     );
  //   }

  //   // Get conversation to find the channel ID
  //   const conversation = await convex.query(api.messages.getConversationById, {
  //     conversationId: conversationId as Id<"conversations">, // Type cast for ID
  //   });

  //   if (!conversation) {
  //     return NextResponse.json(
  //       { error: "Conversation not found" },
  //       { status: 404 }
  //     );
  //   }

  //   // Send message via Nango
  //   const result = await sendSlackMessage(integration.nangoConnectionId, {
  //     channel: conversation.platformConversationId,
  //     text,
  //     thread_ts: threadTs,
  //   });

  //   console.log("Slack message sent:", result);

  //   return NextResponse.json({
  //     success: true,
  //     messageTs: result.ts,
  //     channel: result.channel,
  //   });
  // } catch (error) {
  //   const message = error instanceof Error ? error.message : "Send failed";
  //   console.error("Slack send error:", message);
  //   return NextResponse.json({ error: message }, { status: 500 });
  // }
}
