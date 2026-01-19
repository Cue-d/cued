import { Nango } from "@nangohq/node";
import { env } from "@prm/env/server";

/**
 * Input for sending a Slack message
 */
export interface SendSlackMessageInput {
  channel: string; // Channel ID (C...) or DM ID (D...)
  text: string; // Message content
  thread_ts?: string; // Thread timestamp for replies
}

/**
 * Result of sending a Slack message
 */
export interface SendSlackMessageResult {
  ok: boolean;
  channel: string;
  ts: string; // Message timestamp (unique ID)
  message?: {
    text: string;
    user?: string;
    ts: string;
  };
}

/**
 * Create a Nango client for Slack operations.
 */
export function createNangoSlackClient() {
  return new Nango({ secretKey: env.NANGO_SECRET_KEY });
}

/**
 * Send a message to a Slack channel or DM using Nango action.
 *
 * @param connectionId - The Nango connection ID for the user's Slack workspace
 * @param input - Message details (channel, text, optional thread_ts)
 * @returns The sent message details including timestamp
 * @throws Error if connection not found or message send fails
 */
export async function sendSlackMessage(
  connectionId: string,
  input: SendSlackMessageInput
): Promise<SendSlackMessageResult> {
  const nango = createNangoSlackClient();

  const result = await nango.triggerAction<
    SendSlackMessageInput,
    SendSlackMessageResult
  >("slack", connectionId, "send-message", input);

  return result;
}

/**
 * Send a reply to a Slack thread.
 *
 * @param connectionId - The Nango connection ID for the user's Slack workspace
 * @param channel - Channel ID where the thread exists
 * @param thread_ts - Timestamp of the parent message
 * @param text - Reply message content
 * @returns The sent message details
 */
export async function sendSlackThreadReply(
  connectionId: string,
  channel: string,
  thread_ts: string,
  text: string
): Promise<SendSlackMessageResult> {
  return sendSlackMessage(connectionId, {
    channel,
    text,
    thread_ts,
  });
}
