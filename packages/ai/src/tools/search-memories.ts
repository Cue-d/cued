import { getMemories } from "@mem0/vercel-ai-provider";
import { z } from "zod";
import { getErrorMessage, type Tool, type ToolResult } from "../types.js";

const inputSchema = z.object({
  query: z
    .string()
    .describe("Search query to find relevant memories about a person or topic"),
  contactId: z
    .string()
    .optional()
    .describe("Filter memories to a specific contact/person ID"),
});

// getMemories returns Promise<any> - define shape for type safety
interface Mem0MemoryResponse {
  id: string;
  memory?: string;
  score?: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

interface MemoryResult {
  id: string;
  memory: string;
  score?: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export const searchMemoriesTool: Tool<typeof inputSchema, MemoryResult[]> = {
  name: "search_memories",
  description:
    "Search stored memories about contacts and past interactions. " +
    "Memories contain facts, preferences, and context learned from conversations. " +
    "Use this to recall what you know about a person before composing a message.",
  inputSchema,
  execute: async (input, options): Promise<ToolResult<MemoryResult[]>> => {
    try {
      // user_id = PRM user, contactId = filter by who the memory is about
      const memories = await getMemories(input.query, {
        user_id: options.context.userId,
        filters: input.contactId ? { contact_id: input.contactId } : undefined,
      });

      const results = (memories as Mem0MemoryResponse[])
        .filter((m): m is Mem0MemoryResponse & { memory: string } => !!m.memory)
        .map((m) => ({
          id: m.id,
          memory: m.memory,
          score: m.score,
          metadata: m.metadata,
          createdAt: m.created_at,
        }));

      return { success: true, data: results };
    } catch (error) {
      const message = getErrorMessage(error, "Failed to search memories");
      if (message.includes("API key") || message.includes("MEM0_API_KEY")) {
        return {
          success: false,
          error:
            "Mem0 is not configured. Set MEM0_API_KEY environment variable.",
        };
      }
      return { success: false, error: message };
    }
  },
};
