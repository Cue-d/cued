import { streamText, tool, stepCountIs } from "ai";
import { ConvexHttpClient } from "convex/browser";
import { z } from "zod/v4";
import { openai, DEFAULT_MODEL, SYSTEM_PROMPT, getMemories } from "@prm/ai";
import { api } from "@prm/convex";
import { env } from "@prm/env/server";
import type { Id } from "@prm/convex";

const convex = new ConvexHttpClient(env.NEXT_PUBLIC_CONVEX_URL!);

// Convert UI message format (parts) to Core message format (content)
interface UIMessagePart {
  type: string;
  text?: string;
}

interface UIMessage {
  id: string;
  role: "user" | "assistant";
  parts: UIMessagePart[];
}

interface CoreMessage {
  role: "user" | "assistant";
  content: string;
}

function convertMessages(uiMessages: UIMessage[]): CoreMessage[] {
  return uiMessages.map((msg) => ({
    role: msg.role,
    content: msg.parts
      .filter(
        (p): p is UIMessagePart & { text: string } =>
          p.type === "text" && !!p.text,
      )
      .map((p) => p.text)
      .join(""),
  }));
}

export async function POST(req: Request) {
  const { messages: rawMessages } = await req.json();
  const messages = convertMessages(rawMessages);
  const token = req.headers.get("authorization")?.replace("Bearer ", "");

  if (token) {
    convex.setAuth(token);
  }

  let userId: string | null = null;
  if (token) {
    try {
      const user = await convex.query(api.users.getCurrentUser);
      userId = user?.subject ?? null;
    } catch {
      // Continue without user context
    }
  }

  const result = streamText({
    model: openai(DEFAULT_MODEL),
    system: SYSTEM_PROMPT,
    messages,
    tools: {
      search_messages: tool({
        description:
          "Search through message history to find messages matching a query. " +
          "Returns messages with sender info and conversation context. " +
          "Use this to find past conversations, specific topics, or messages from a person.",
        inputSchema: z.object({
          query: z
            .string()
            .describe("Search query to match against message content"),
          limit: z
            .number()
            .optional()
            .describe(
              "Maximum number of results to return (default: 20, max: 50)",
            ),
          conversationId: z
            .string()
            .optional()
            .describe("Limit search to a specific conversation ID"),
        }),
        execute: async ({ query, limit, conversationId }) => {
          if (!userId) return { results: [], error: "Not authenticated" };
          const result = await convex.query(api.search.searchMessages, {
            query,
            limit,
            conversationId: conversationId as Id<"conversations"> | undefined,
          });
          return result;
        },
      }),

      search_contacts: tool({
        description:
          "Search for contacts by name. Returns matching contacts with all their handles (phone, email, Slack).",
        inputSchema: z.object({
          query: z.string().describe("Name to search for"),
          limit: z
            .number()
            .optional()
            .describe("Maximum number of results (default: 10, max: 25)"),
        }),
        execute: async ({ query, limit }) => {
          if (!userId) return { results: [], error: "Not authenticated" };
          const result = await convex.query(api.search.searchContacts, {
            query,
            limit,
          });
          return result;
        },
      }),

      get_conversations: tool({
        description:
          "Get recent conversations from the inbox. Returns conversations sorted by last message time.",
        inputSchema: z.object({
          limit: z
            .number()
            .optional()
            .describe("Maximum number of conversations (default: 10, max: 50)"),
          platform: z
            .enum(["imessage", "gmail", "slack"])
            .optional()
            .describe("Filter by platform"),
        }),
        execute: async ({ limit, platform }) => {
          if (!userId)
            return {
              conversations: [],
              hasMore: false,
              error: "Not authenticated",
            };
          const result = await convex.query(api.messages.getInbox, {
            limit,
            platform,
          });
          return result;
        },
      }),

      create_action: tool({
        description:
          "Create an action for the user to review. Actions appear in the action queue as swipeable cards.",
        inputSchema: z.object({
          type: z
            .enum(["respond", "follow_up", "send_message", "eod_contact"])
            .describe("Type of action"),
          conversationId: z
            .string()
            .optional()
            .describe("Conversation this action relates to"),
          contactId: z
            .string()
            .optional()
            .describe("Contact this action relates to"),
          reason: z.string().optional().describe("Why this action was created"),
          priority: z
            .number()
            .optional()
            .describe("Priority 0-100 (default: 50)"),
        }),
        execute: async ({
          type,
          conversationId,
          contactId,
          reason,
          priority,
        }) => {
          if (!userId) return { error: "Not authenticated" };
          const actionId = await convex.mutation(api.actions.createAction, {
            type,
            conversationId: conversationId as Id<"conversations"> | undefined,
            contactId: contactId as Id<"contacts"> | undefined,
            reason,
            priority,
          });
          return { actionId, created: true };
        },
      }),

      search_memories: tool({
        description:
          "Search stored memories about contacts. Memories are facts and context extracted from past conversations.",
        inputSchema: z.object({
          query: z.string().describe("What to search for in memories"),
          contactId: z
            .string()
            .optional()
            .describe("Filter memories about a specific contact"),
        }),
        execute: async ({ query, contactId }) => {
          if (!userId) return { memories: [], error: "Not authenticated" };

          try {
            const memories = await getMemories(query, {
              user_id: userId,
              filters: contactId ? { contact_id: contactId } : undefined,
            });

            type MemoryResult = { id: string; memory?: string; score?: number };
            const results = ((memories as MemoryResult[]) || [])
              .filter((m) => m.memory)
              .map((m) => ({ id: m.id, memory: m.memory, score: m.score }));

            return { memories: results };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Unknown error";
            if (
              message.includes("API key") ||
              message.includes("MEM0_API_KEY")
            ) {
              return { memories: [], error: "Mem0 not configured" };
            }
            return { memories: [], error: message };
          }
        },
      }),

      search_actions: tool({
        description:
          "Search the action queue with filters. " +
          "Actions are tasks like 'respond to message', 'follow up with contact'. " +
          "Use this to find pending follow-ups, check what actions exist for a contact, or see completed tasks.",
        inputSchema: z.object({
          status: z
            .enum(["pending", "completed", "discarded", "snoozed"])
            .optional()
            .describe("Filter by action status"),
          type: z
            .enum(["respond", "follow_up", "send_message", "eod_contact"])
            .optional()
            .describe("Filter by action type"),
          contactId: z.string().optional().describe("Filter by contact ID"),
          conversationId: z
            .string()
            .optional()
            .describe("Filter by conversation ID"),
          createdAfter: z
            .number()
            .optional()
            .describe(
              "Filter actions created after this timestamp (ms since epoch)",
            ),
          snoozedUntilBefore: z
            .number()
            .optional()
            .describe("Filter snoozed actions due before this timestamp"),
          limit: z
            .number()
            .optional()
            .describe("Maximum number of results (default: 20, max: 100)"),
        }),
        execute: async (input) => {
          if (!userId) return { actions: [], error: "Not authenticated" };
          return convex.query(api.actions.searchActions, {
            ...input,
            contactId: input.contactId as Id<"contacts"> | undefined,
            conversationId: input.conversationId as
              | Id<"conversations">
              | undefined,
          });
        },
      }),
    },
    stopWhen: stepCountIs(5), // Allow up to 5 tool call steps
    onError: (error) => {
      console.error("Stream error:", error);
    },
  });

  return result.toUIMessageStreamResponse();
}
