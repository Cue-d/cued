import { z } from "zod";
import { getErrorMessage, type Tool, type ToolResult } from "../types";

const ACTION_TYPES = ["respond", "follow_up", "send_message", "eod_contact"] as const;

const TYPE_LABELS: Record<(typeof ACTION_TYPES)[number], string> = {
  respond: "response",
  follow_up: "follow-up",
  send_message: "message",
  eod_contact: "contact review",
};

const inputSchema = z.object({
  type: z
    .enum(ACTION_TYPES)
    .describe(
      "Action type: respond (reply to message), follow_up (scheduled reminder), " +
        "send_message (new outreach), eod_contact (end-of-day contact review)"
    ),
  conversationId: z.string().optional().describe("Conversation ID this action relates to"),
  contactId: z.string().optional().describe("Contact ID this action relates to"),
  messageId: z.string().optional().describe("Specific message ID this action responds to"),
  reason: z.string().optional().describe("Reason or context for creating this action"),
  priority: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Priority score 0-100 (higher = more urgent)"),
});

interface CreateActionResult {
  actionId: string;
  message: string;
}

export const createActionTool: Tool<typeof inputSchema, CreateActionResult> = {
  name: "create_action",
  description:
    "Create an action item for the user to handle. " +
    "Actions appear in the action queue for the user to review, edit, and complete. " +
    "Use this to queue up follow-ups, responses, or outreach tasks.",
  inputSchema,
  execute: async (input, options): Promise<ToolResult<CreateActionResult>> => {
    try {
      const result = await options.context.mutation<{ actionId: string }>(
        "actions:createAction",
        {
          type: input.type,
          conversationId: input.conversationId,
          contactId: input.contactId,
          messageId: input.messageId,
          reason: input.reason,
          priority: input.priority,
        }
      );

      return {
        success: true,
        data: {
          actionId: result.actionId,
          message: `Created ${TYPE_LABELS[input.type]} action`,
        },
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, "Failed to create action") };
    }
  },
};
