import { z } from "zod";
import { getErrorMessage, type Tool, type ToolResult } from "../types";

const ACTION_TYPES = ["respond", "follow_up", "send_message"] as const;

const TYPE_LABELS: Record<(typeof ACTION_TYPES)[number], string> = {
  respond: "response",
  follow_up: "follow-up",
  send_message: "message",
};

const inputSchema = z.object({
  type: z
    .enum(ACTION_TYPES)
    .describe(
      "Action type: respond (reply to message), follow_up (scheduled reminder), " +
        "send_message (new outreach)"
    ),
  conversationId: z.string().optional().describe("Conversation ID this action relates to"),
  contactId: z.string().optional().describe("Contact ID this action relates to"),
  messageId: z.string().optional().describe("Specific message ID this action responds to"),
  summary: z
    .string()
    .optional()
    .describe("Super-short summary for list cards (2-5 words)"),
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
  summary?: string;
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
          summary: input.summary,
          reason: input.reason,
          priority: input.priority,
        }
      );

      return {
        success: true,
        data: {
          actionId: result.actionId,
          message: `Created ${TYPE_LABELS[input.type]} action`,
          summary: input.summary,
        },
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, "Failed to create action") };
    }
  },
};
