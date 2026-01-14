import { z } from "zod";
import { getErrorMessage, type Tool, type ToolResult } from "../types.js";

const inputSchema = z.object({
  query: z.string().describe("Search query to find relevant memories about a person or topic"),
  contactId: z.string().optional().describe("Filter memories to a specific contact/person ID"),
  limit: z.number().optional().describe("Maximum number of memories to return (default: 10)"),
});

interface MemoryResult {
  id: string;
  memory: string;
  score?: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

interface Mem0Memory {
  id: string;
  memory?: string;
  score?: number;
  metadata?: Record<string, unknown>;
  created_at?: Date;
}

interface Mem0Client {
  search: (query: string, options: { user_id?: string; limit?: number }) => Promise<Mem0Memory[]>;
}

let mem0Client: Mem0Client | null = null;
let mem0Initialized = false;

async function getMem0Client(): Promise<Mem0Client | null> {
  if (mem0Initialized) return mem0Client;
  mem0Initialized = true;

  const apiKey = process.env.MEM0_API_KEY;
  if (!apiKey) return null;

  try {
    const { default: MemoryClient } = await import("mem0ai");
    mem0Client = new MemoryClient({ apiKey }) as Mem0Client;
    return mem0Client;
  } catch {
    return null;
  }
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
      const client = await getMem0Client();
      if (!client) {
        return {
          success: false,
          error: "Mem0 is not configured. Set MEM0_API_KEY environment variable.",
        };
      }

      const mem0UserId = input.contactId
        ? `${options.context.userId}:${input.contactId}`
        : options.context.userId;

      const memories = await client.search(input.query, {
        user_id: mem0UserId,
        limit: input.limit ?? 10,
      });

      const results = memories
        .filter((m): m is Mem0Memory & { memory: string } => !!m.memory)
        .map((m) => ({
          id: m.id,
          memory: m.memory,
          score: m.score,
          metadata: m.metadata,
          createdAt: m.created_at?.toISOString(),
        }));

      return { success: true, data: results };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, "Failed to search memories") };
    }
  },
};
