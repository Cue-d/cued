import { z } from "zod";
import type { ContactHandle } from "@prm/shared";
import { getErrorMessage, type Tool, type ToolResult } from "../types";

const inputSchema = z.object({
  query: z.string().describe("Name or partial name to search for"),
  limit: z
    .number()
    .optional()
    .describe("Maximum number of results to return (default: 20, max: 50)"),
});

interface ContactSearchResult {
  _id: string;
  displayName: string;
  company: string | null;
  notes: string | null;
  importance: number | null;
  handles: ContactHandle[];
}

export const searchContactsTool: Tool<
  typeof inputSchema,
  ContactSearchResult[]
> = {
  name: "search_contacts",
  description:
    "Search for contacts by name. " +
    "Returns contact details including all their communication handles (phone, email, Slack). " +
    "Use this to find contact information or look up a person.",
  inputSchema,
  execute: async (input, options): Promise<ToolResult<ContactSearchResult[]>> => {
    try {
      const result = await options.context.query<{
        results: ContactSearchResult[];
      }>("search:searchContacts", {
        query: input.query,
        limit: input.limit,
      });

      return { success: true, data: result.results };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, "Search failed") };
    }
  },
};
