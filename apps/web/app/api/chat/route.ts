import { streamText, stepCountIs } from "ai";
import { ConvexHttpClient } from "convex/browser";
import {
  openai,
  DEFAULT_MODEL,
  buildSystemPrompt,
  createChatTools,
  type MentionedContact,
} from "@prm/ai";
import { api } from "@prm/convex";
import { env } from "@prm/env/server";
import type { Id } from "@prm/convex";

const convex = new ConvexHttpClient(env.NEXT_PUBLIC_CONVEX_URL!);

interface UIMessage {
  id: string;
  role: "user" | "assistant";
  parts: { type: string; text?: string }[];
}

function convertMessages(uiMessages: UIMessage[]): { role: "user" | "assistant"; content: string }[] {
  return uiMessages.map((msg) => ({
    role: msg.role,
    content: msg.parts
      .filter((p): p is { type: string; text: string } => p.type === "text" && !!p.text)
      .map((p) => p.text)
      .join(""),
  }));
}

async function fetchMentionedContacts(
  convex: ConvexHttpClient,
  contactIds: string[],
): Promise<MentionedContact[]> {
  if (contactIds.length === 0) return [];

  const contacts = await Promise.all(
    contactIds.map(async (id): Promise<MentionedContact | null> => {
      try {
        const result = await convex.query(api.contacts.getContact, {
          contactId: id as Id<"contacts">,
        });
        if (!result) return null;

        return {
          displayName: result.displayName,
          company: result.company ?? undefined,
          handles: result.handles?.map((h) => ({
            type: h.type as "phone" | "email" | "slack_id",
            value: h.value,
          })),
          notes: result.notes ?? undefined,
        };
      } catch (error) {
        console.error(`Failed to fetch mentioned contact ${id}:`, error);
        return null;
      }
    }),
  );

  const validContacts = contacts.filter((c): c is MentionedContact => c !== null);
  const failedCount = contacts.length - validContacts.length;
  if (failedCount > 0) {
    console.warn(
      `Failed to fetch ${failedCount} of ${contactIds.length} mentioned contacts`,
    );
  }

  return validContacts;
}

export async function POST(req: Request) {
  const { messages: rawMessages, mentionedContactIds: rawContactIds } =
    await req.json();
  const messages = convertMessages(rawMessages);
  const token = req.headers.get("authorization")?.replace("Bearer ", "");

  const mentionedContactIds = Array.isArray(rawContactIds)
    ? rawContactIds
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .slice(0, 10)
    : [];

  if (token) {
    convex.setAuth(token);
  }

  let userId: string | null = null;
  if (token) {
    try {
      const user = await convex.query(api.users.getCurrentUser);
      userId = user?.subject ?? null;
    } catch (error) {
      console.error("Failed to fetch current user:", error);
    }
  }

  const mentionedContacts = await fetchMentionedContacts(convex, mentionedContactIds);

  const systemPrompt = buildSystemPrompt({
    mentionedContacts: mentionedContacts.length > 0 ? mentionedContacts : undefined,
  });

  const tools = createChatTools(
    convex,
    {
      search: {
        searchMessages: api.search.searchMessages,
        searchContacts: api.search.searchContacts,
      },
      messages: {
        getInbox: api.messages.getInbox,
      },
      actions: {
        createAction: api.actions.createAction,
        searchActions: api.actions.searchActions,
      },
    },
    userId,
  );

  const result = streamText({
    model: openai(DEFAULT_MODEL),
    system: systemPrompt,
    messages,
    tools,
    stopWhen: stepCountIs(5),
    onError: (error) => {
      console.error("Stream error:", error);
    },
  });

  return result.toUIMessageStreamResponse();
}
