import { stepCountIs, streamText } from "ai";
import { ConvexHttpClient } from "convex/browser";
import {
  buildSystemPrompt,
  createChatTools,
  gateway,
  MODEL,
  type MentionedContact,
} from "@cued/ai";
import { api, type Id } from "@cued/convex";
import { getConvexClient } from "@/lib/api-utils";

// Allowed origins for CORS - web app and Electron
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "https://cued.so",
  "https://www.cued.so",
  "https://app.cued.so",
];

function getCorsHeaders(origin: string | null): Record<string, string> {
  // Only allow known origins, reject others
  const allowedOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

export function OPTIONS(req: Request): Response {
  const origin = req.headers.get("origin");
  return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
}

interface UIMessage {
  id: string;
  role: "user" | "assistant";
  parts: { type: string; text?: string }[];
}

type ChatMessage = { role: "user" | "assistant"; content: string };

function convertMessages(uiMessages: UIMessage[]): ChatMessage[] {
  return uiMessages.map((msg) => ({
    role: msg.role,
    content: msg.parts
      .filter((p): p is { type: string; text: string } => p.type === "text" && !!p.text)
      .map((p) => p.text)
      .join(""),
  }));
}

function toMentionedContact(result: {
  displayName: string;
  company?: string | null;
  handles?: { type: string; value: string }[] | null;
  notes?: string | null;
}): MentionedContact {
  return {
    displayName: result.displayName,
    company: result.company ?? undefined,
    handles: result.handles?.map((h) => ({
      type: h.type as "phone" | "email" | "slack_id",
      value: h.value,
    })),
    notes: result.notes ?? undefined,
  };
}

async function fetchMentionedContacts(
  convex: ConvexHttpClient,
  contactIds: string[],
): Promise<MentionedContact[]> {
  if (contactIds.length === 0) return [];

  const results = await Promise.all(
    contactIds.map(async (id) => {
      const result = await convex
        .query(api.contacts.getContact, { contactId: id as Id<"contacts"> })
        .catch((error) => {
          console.error(`Failed to fetch contact ${id}:`, error);
          return null;
        });
      return result ? toMentionedContact(result) : null;
    }),
  );

  const contacts = results.filter((c): c is MentionedContact => c !== null);
  const failedCount = results.length - contacts.length;
  if (failedCount > 0) {
    console.warn(`Failed to fetch ${failedCount}/${contactIds.length} mentioned contacts`);
  }

  return contacts;
}

function parseContactIds(rawContactIds: unknown): string[] {
  if (!Array.isArray(rawContactIds)) return [];
  return rawContactIds
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .slice(0, 10);
}

async function getCurrentUserId(convex: ConvexHttpClient): Promise<string | null> {
  const user = await convex
    .query(api.users.getCurrentUser)
    .catch((error) => {
      console.error("Failed to fetch current user:", error);
      return null;
    });
  return user?.subject ?? null;
}

function withCorsHeaders(response: Response, origin: string | null): Response {
  const corsHeaders = getCorsHeaders(origin);
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function errorResponse(error: unknown, origin: string | null): Response {
  const message = error instanceof Error ? error.message : "Unknown error";
  return new Response(JSON.stringify({ error: message }), {
    status: 500,
    headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
  });
}

const CHAT_TOOLS_API = {
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
};

export async function POST(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");

  try {
    const { messages: rawMessages, mentionedContactIds: rawContactIds } = await req.json();
    const messages = convertMessages(rawMessages);
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    const contactIds = parseContactIds(rawContactIds);

    const convex = getConvexClient();
    if (token) {
      convex.setAuth(token);
    }

    const userId = token ? await getCurrentUserId(convex) : null;
    const mentionedContacts = await fetchMentionedContacts(convex, contactIds);

    const systemPrompt = buildSystemPrompt({
      mentionedContacts: mentionedContacts.length > 0 ? mentionedContacts : undefined,
    });

    const result = streamText({
      model: gateway(MODEL),
      system: systemPrompt,
      messages,
      tools: createChatTools(convex, CHAT_TOOLS_API, userId),
      stopWhen: stepCountIs(5),
      onError: (error) => console.error("Stream error:", error),
    });

    return withCorsHeaders(result.toUIMessageStreamResponse(), origin);
  } catch (error) {
    console.error("Chat API error:", error);
    return errorResponse(error, origin);
  }
}
