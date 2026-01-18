import { z } from "zod";
import { getErrorMessage, type Tool, type ToolResult } from "../types";

const inputSchema = z.object({
  status: z
    .enum(["pending", "completed", "discarded", "snoozed"])
    .optional()
    .describe("Filter by action status"),
  type: z
    .enum(["respond", "follow_up", "send_message", "eod_contact"])
    .optional()
    .describe("Filter by action type"),
  contactId: z.string().optional().describe("Filter by contact ID"),
  conversationId: z.string().optional().describe("Filter by conversation ID"),
  createdAfter: z
    .number()
    .optional()
    .describe("Filter actions created after this timestamp (ms since epoch)"),
  snoozedUntilBefore: z
    .number()
    .optional()
    .describe(
      "Filter snoozed actions due before this timestamp (for finding overdue items)"
    ),
  limit: z
    .number()
    .optional()
    .describe("Maximum number of results to return (default: 20, max: 100)"),
});

interface ActionSearchResult {
  _id: string;
  type: string;
  status: string;
  priority: number;
  draftMessage: string | null;
  reason: string | null;
  createdAt: number;
  completedAt: number | null;
  snoozedUntil: number | null;
  conversationId: string | null;
  contactId: string | null;
  contactName: string | null;
  platform: string | null;
}

export const searchActionsTool: Tool<
  typeof inputSchema,
  ActionSearchResult[]
> = {
  name: "search_actions",
  description:
    "Search the action queue with filters. " +
    "Actions are tasks like 'respond to message', 'follow up with contact'. " +
    "Use this to find pending follow-ups, check what actions exist for a contact, or see completed tasks.",
  inputSchema,
  execute: async (input, options): Promise<ToolResult<ActionSearchResult[]>> => {
    try {
      const result = await options.context.query<{
        actions: ActionSearchResult[];
      }>("actions:searchActions", {
        ...input,
        contactId: input.contactId?.trim() || undefined,
        conversationId: input.conversationId?.trim() || undefined,
      });

      return { success: true, data: result.actions };
    } catch (error) {
      return {
        success: false,
        error: getErrorMessage(error, "Action search failed"),
      };
    }
  },
};
