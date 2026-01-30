import { Nango } from "@nangohq/node";
import { env } from "@cued/env/server";

/**
 * Input for sending a Gmail email
 */
export interface SendGmailMessageInput {
  to: string; // Recipient email address
  subject: string; // Email subject line
  body: string; // Email body (plain text)
  threadId?: string; // Gmail thread ID for replies
  inReplyTo?: string; // Message-ID of email being replied to
  references?: string; // References header for threading
}

/**
 * Result of sending a Gmail email
 */
export interface SendGmailMessageResult {
  id: string; // Gmail message ID
  threadId: string; // Gmail thread ID
  labelIds?: string[]; // Labels applied to message
}

/**
 * Create a Nango client for Gmail operations.
 */
export function createNangoGmailClient() {
  return new Nango({ secretKey: env.NANGO_SECRET_KEY });
}

/**
 * Send an email via Gmail using Nango action.
 *
 * @param connectionId - The Nango connection ID for the user's Gmail account
 * @param input - Email details (to, subject, body, optional threading fields)
 * @returns The sent message details including ID and threadId
 * @throws Error if connection not found or message send fails
 */
export async function sendGmailMessage(
  connectionId: string,
  input: SendGmailMessageInput
): Promise<SendGmailMessageResult> {
  const nango = createNangoGmailClient();

  return nango.triggerAction<SendGmailMessageInput, SendGmailMessageResult>(
    "google",
    connectionId,
    "send-email",
    input
  );
}

/**
 * Send a reply to a Gmail thread.
 *
 * @param connectionId - The Nango connection ID for the user's Gmail account
 * @param threadId - Gmail thread ID to reply to
 * @param to - Recipient email address
 * @param subject - Reply subject (typically "Re: Original Subject")
 * @param body - Reply message content
 * @param inReplyTo - Message-ID of the email being replied to (optional)
 * @param references - References header for threading (optional)
 * @returns The sent message details
 */
export async function sendGmailReply(
  connectionId: string,
  threadId: string,
  to: string,
  subject: string,
  body: string,
  inReplyTo?: string,
  references?: string
): Promise<SendGmailMessageResult> {
  return sendGmailMessage(connectionId, {
    to,
    subject,
    body,
    threadId,
    inReplyTo,
    references,
  });
}
