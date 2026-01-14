import { z } from "zod";
import { getErrorMessage, type Tool, type ToolResult } from "../types";

const inputSchema = z.object({
  query: z.string().describe("Search query to match against message content"),
  limit: z
    .number()
    .optional()
    .describe("Maximum number of results to return (default: 20, max: 50)"),
  conversationId: z
    .string()
    .optional()
    .describe("Limit search to a specific conversation ID"),
});

interface MessageSearchResult {
  _id: string;
  conversationId: string;
  content: string;
  sentAt: number;
  isFromMe: boolean;
  platform: string;
  senderName: string | null;
  conversationName: string | null;
}

export const searchMessagesTool: Tool<
  typeof inputSchema,
  MessageSearchResult[]
> = {
  name: "search_messages",
  description:
    "Search through message history to find messages matching a query. " +
    "Automatically searches ALL connected platforms (iMessage, etc.) " +
    "Returns messages with sender info and conversation context. " +
    "Use this to find past conversations, specific topics, or messages from a person.",
  inputSchema,
  execute: async (
    input,
    options
  ): Promise<ToolResult<MessageSearchResult[]>> => {
    try {
      const result = await options.context.query<{
        results: MessageSearchResult[];
      }>("search:searchMessages", {
        query: input.query,
        limit: input.limit,
        conversationId: input.conversationId || undefined,
      });

      return { success: true, data: result.results };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, "Search failed") };
    }
  },
};
