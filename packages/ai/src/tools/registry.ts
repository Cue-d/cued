import { tool } from "ai";
import { z } from "zod/v4";

const searchMessagesSchema = z.object({
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

const searchContactsSchema = z.object({
  query: z.string().describe("Name to search for"),
  limit: z
    .number()
    .optional()
    .describe("Maximum number of results (default: 10, max: 25)"),
});

const getConversationsSchema = z.object({
  limit: z
    .number()
    .optional()
    .describe("Maximum number of conversations (default: 10, max: 50)"),
  platform: z
    .enum(["imessage", "gmail", "slack"])
    .optional()
    .describe("Filter by platform"),
});

const createActionSchema = z.object({
  type: z
    .enum(["respond", "follow_up", "send_message", "eod_contact"])
    .describe(
      "Action type: respond (reply to message), follow_up (scheduled reminder), " +
        "send_message (new outreach), eod_contact (end-of-day contact review)"
    ),
  conversationId: z
    .string()
    .optional()
    .describe("Conversation this action relates to"),
  contactId: z.string().optional().describe("Contact this action relates to"),
  messageId: z
    .string()
    .optional()
    .describe("Specific message this action responds to"),
  reason: z.string().optional().describe("Why this action was created"),
  priority: z.number().optional().describe("Priority 0-100 (default: 50)"),
});

const searchActionsSchema = z.object({
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
    .describe("Filter snoozed actions due before this timestamp"),
  limit: z
    .number()
    .optional()
    .describe("Maximum number of results (default: 20, max: 100)"),
});

export interface ToolConvexClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: (fn: any, args: any) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mutation: (fn: any, args: any) => Promise<any>;
}

export interface ConvexApi {
  search: {
    searchMessages: unknown;
    searchContacts: unknown;
  };
  messages: {
    getInbox: unknown;
  };
  actions: {
    createAction: unknown;
    searchActions: unknown;
  };
}

export function createToolResult<T>(
  data: T,
  error?: string
): { results: T; error?: string } {
  return error ? { results: data, error } : { results: data };
}

export function createChatTools(
  convex: ToolConvexClient,
  api: ConvexApi,
  userId: string | null
) {
  return {
    search_messages: tool({
      description:
        "Search through message history to find messages matching a query. " +
        "Automatically searches ALL connected platforms (iMessage, Gmail, Slack). " +
        "Returns messages with sender info and conversation context. " +
        "Use this to find past conversations, specific topics, or messages from a person.",
      inputSchema: searchMessagesSchema,
      execute: async (input: z.infer<typeof searchMessagesSchema>) => {
        if (!userId) return createToolResult([], "Not authenticated");
        const result = await convex.query(
          api.search.searchMessages,
          { query: input.query, limit: input.limit, conversationId: input.conversationId }
        ) as { results: unknown[] };
        return createToolResult(result.results);
      },
    }),

    search_contacts: tool({
      description:
        "Search for contacts by name. " +
        "Returns contact details including all their communication handles (phone, email, Slack). " +
        "Use this to find contact information or look up a person.",
      inputSchema: searchContactsSchema,
      execute: async (input: z.infer<typeof searchContactsSchema>) => {
        if (!userId) return createToolResult([], "Not authenticated");
        const result = await convex.query(
          api.search.searchContacts,
          { query: input.query, limit: input.limit }
        ) as { results: unknown[] };
        return createToolResult(result.results);
      },
    }),

    get_conversations: tool({
      description:
        "Get recent conversations from the inbox. " +
        "Returns conversations sorted by last message time. " +
        "Use this to see what's happening in the user's inbox.",
      inputSchema: getConversationsSchema,
      execute: async (input: z.infer<typeof getConversationsSchema>) => {
        if (!userId)
          return { results: [], hasMore: false, error: "Not authenticated" };
        const result = await convex.query(
          api.messages.getInbox,
          { limit: input.limit, platform: input.platform }
        ) as { conversations: unknown[]; nextCursor: string | null };
        return { results: result.conversations, hasMore: result.nextCursor !== null };
      },
    }),

    create_action: tool({
      description:
        "Create an action for the user to review. " +
        "Actions appear in the action queue as swipeable cards. " +
        "Use this to queue follow-ups, responses, or outreach tasks.",
      inputSchema: createActionSchema,
      execute: async (input: z.infer<typeof createActionSchema>) => {
        if (!userId) return { actionId: null, error: "Not authenticated" };
        const { actionId } = await convex.mutation(
          api.actions.createAction,
          {
            type: input.type,
            conversationId: input.conversationId,
            contactId: input.contactId,
            messageId: input.messageId,
            reason: input.reason,
            priority: input.priority,
          }
        ) as { actionId: string };
        return { actionId, type: input.type, priority: input.priority ?? 50, reason: input.reason, created: true };
      },
    }),

    search_actions: tool({
      description:
        "Search the action queue with filters. " +
        "Actions are tasks like 'respond to message', 'follow up with contact'. " +
        "Use this to find pending follow-ups, check what actions exist for a contact, or see completed tasks.",
      inputSchema: searchActionsSchema,
      execute: async (input: z.infer<typeof searchActionsSchema>) => {
        if (!userId) return createToolResult([], "Not authenticated");
        const result = await convex.query(
          api.actions.searchActions,
          input
        ) as { actions: unknown[] };
        return createToolResult(result.actions);
      },
    }),
  };
}
