/**
 * Email sending via Nango (Gmail).
 * Convex action that calls Nango to trigger email send.
 */
import { v } from "convex/values";
import { internalAction } from "./_generated/server";

const NANGO_SECRET_KEY = process.env.NANGO_SECRET_KEY;
const NANGO_BASE_URL = "https://api.nango.dev";

interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}

interface SendEmailResult {
  id: string;
  threadId: string;
  labelIds?: string[];
}

/**
 * Send a Gmail email via Nango.
 * Called internally after swipeAction schedules this action.
 */
export const sendGmailEmail = internalAction({
  args: {
    connectionId: v.string(),
    to: v.string(),
    subject: v.string(),
    body: v.string(),
    threadId: v.optional(v.string()),
    inReplyTo: v.optional(v.string()),
    references: v.optional(v.string()),
    // Tracking
    actionId: v.optional(v.id("actions")),
    conversationId: v.optional(v.id("conversations")),
  },
  handler: async (_ctx, args) => {
    // TODO: DISABLED - Comment out to prevent accidentally contacting people
    console.log("[EmailSender] DISABLED - would have sent email:", {
      to: args.to,
      subject: args.subject,
      body: args.body.substring(0, 50) + "...",
    });
    return {
      success: true,
      messageId: "DISABLED",
      threadId: "DISABLED",
    };

    // if (!NANGO_SECRET_KEY) {
    //   throw new Error("NANGO_SECRET_KEY not configured");
    // }

    // const input: SendEmailInput = {
    //   to: args.to,
    //   subject: args.subject,
    //   body: args.body,
    //   threadId: args.threadId,
    //   inReplyTo: args.inReplyTo,
    //   references: args.references,
    // };

    // // Call Nango trigger action API
    // const response = await fetch(
    //   `${NANGO_BASE_URL}/action/trigger`,
    //   {
    //     method: "POST",
    //     headers: {
    //       "Authorization": `Bearer ${NANGO_SECRET_KEY}`,
    //       "Content-Type": "application/json",
    //     },
    //     body: JSON.stringify({
    //       provider_config_key: "google",
    //       connection_id: args.connectionId,
    //       action_name: "send-email",
    //       input,
    //     }),
    //   }
    // );

    // if (!response.ok) {
    //   const error = await response.text();
    //   console.error("[EmailSender] Nango action failed:", error);
    //   throw new Error(`Gmail send failed: ${response.status} ${error}`);
    // }

    // const result = (await response.json()) as SendEmailResult;
    // console.log("[EmailSender] Gmail sent:", result.id, "thread:", result.threadId);

    // return {
    //   success: true,
    //   messageId: result.id,
    //   threadId: result.threadId,
    // };
  },
});
