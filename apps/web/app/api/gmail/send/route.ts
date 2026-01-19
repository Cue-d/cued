import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { Id } from "@prm/convex";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { api } from "@prm/convex";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { sendGmailMessage } from "@prm/integrations/nango";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

interface SendGmailMessageRequest {
  workosUserId: string;
  conversationId: string;
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}

/**
 * POST /api/gmail/send
 * Send a Gmail message and update action status.
 *
 * Called when completing a Gmail-platform action (respond/follow_up).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // TODO: DISABLED - Comment out to prevent accidentally contacting people
  const body = (await request.json()) as SendGmailMessageRequest;
  console.log("[Gmail API] DISABLED - would have sent email:", {
    to: body.to,
    subject: body.subject,
    body: body.body?.substring(0, 50) + "...",
  });
  return NextResponse.json({
    success: true,
    messageId: "DISABLED",
    threadId: "DISABLED",
  });

  // try {
  //   const body = (await request.json()) as SendGmailMessageRequest;
  //   const { workosUserId, conversationId, to, subject, body: emailBody, threadId, inReplyTo, references } = body;

  //   if (!workosUserId || !conversationId || !to || !subject || !emailBody) {
  //     return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  //   }

  //   // Get user's Gmail connection from Convex
  //   const integration = await convex.query(api.integrations.getIntegration, {
  //     workosUserId,
  //     platform: "gmail",
  //   });

  //   if (!integration?.nangoConnectionId) {
  //     return NextResponse.json({ error: "Gmail not connected" }, { status: 400 });
  //   }

  //   // Verify conversation exists
  //   const conversationExists = await convex.query(api.messages.getConversationById, {
  //     conversationId: conversationId as Id<"conversations">,
  //   });

  //   if (!conversationExists) {
  //     return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  //   }

  //   // Send email via Nango
  //   const result = await sendGmailMessage(integration.nangoConnectionId, {
  //     to,
  //     subject,
  //     body: emailBody,
  //     threadId,
  //     inReplyTo,
  //     references,
  //   });

  //   console.log("Gmail message sent:", result);

  //   return NextResponse.json({
  //     success: true,
  //     messageId: result.id,
  //     threadId: result.threadId,
  //   });
  // } catch (error) {
  //   const message = error instanceof Error ? error.message : "Send failed";
  //   console.error("Gmail send error:", message);
  //   return NextResponse.json({ error: message }, { status: 500 });
  // }
}
