import { NextRequest, NextResponse } from "next/server";

interface SendGmailMessageRequest {
  to: string;
  subject: string;
  body: string;
}

/**
 * POST /api/gmail/send
 * Send a Gmail message and update action status.
 *
 * NOTE: Currently disabled to prevent accidental emails.
 * TODO: Re-enable when ready for production use.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
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
}
