import { z } from "zod";
import { getErrorMessage, type Tool, type ToolResult } from "../types";

const inputSchema = z.object({
  limit: z
    .number()
    .optional()
    .describe("Maximum number of conversations to return (default: 10, max: 50)"),
});

interface ConversationResult {
  _id: string;
  platform: string;
  conversationType: string;
  displayName: string;
  lastMessageText: string | null;
  lastMessageAt: number | null;
  unreadCount: number;
}

export const getConversationsTool: Tool<typeof inputSchema, ConversationResult[]> = {
  name: "get_conversations",
  description:
    "Get a list of recent conversations. " +
    "Returns conversations sorted by most recent activity. " +
    "Use this to see who the user has been talking to recently.",
  inputSchema,
  execute: async (input, options): Promise<ToolResult<ConversationResult[]>> => {
    try {
      const result = await options.context.query<{
        results: ConversationResult[];
      }>("search:getRecentConversations", {
        limit: input.limit,
      });

      return { success: true, data: result.results };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, "Failed to get conversations") };
    }
  },
};
