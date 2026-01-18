import {
  createMem0,
  addMemories,
  getMemories,
  retrieveMemories,
  searchMemories,
  type Mem0Provider,
  type Mem0ConfigSettings,
} from "@mem0/vercel-ai-provider";
import { buildMemoryInstructions } from "./prompts/memory";

export function createMem0Provider(): Mem0Provider {
  return createMem0({ provider: "openai" });
}

export interface AddMemoriesResult {
  memoriesAdded: number;
  memoriesUpdated: number;
  memoriesDeleted: number;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

function formatConversationForMem0(
  messages: ConversationMessage[],
  contactName?: string
): string {
  const senderLabel = contactName || "Contact";
  return messages
    .map((m) => {
      const prefix = m.role === "user" ? "Me" : senderLabel;
      return `${prefix}: ${m.content}`;
    })
    .join("\n");
}

export async function addContactMemories(
  messages: ConversationMessage[],
  userId: string,
  contactId: string,
  contactName?: string
): Promise<AddMemoriesResult> {
  if (messages.length === 0) {
    return { memoriesAdded: 0, memoriesUpdated: 0, memoriesDeleted: 0 };
  }

  const conversationText = formatConversationForMem0(messages, contactName);
  const customInstructions = buildMemoryInstructions(contactName);

  // Cast needed because type def says LanguageModelV2Prompt but implementation accepts string
  // async_mode: false required to get synchronous results with event types (ADD/UPDATE/DELETE)
  // See: https://docs.mem0.ai/platform/features/async-mode-default-change
  const result = await addMemories(
    conversationText as unknown as Parameters<typeof addMemories>[0],
    {
      user_id: userId,
      metadata: { contact_id: contactId },
      custom_instructions: customInstructions,
      async_mode: false,
    } as Mem0ConfigSettings
  );

  // Response format: array directly when async_mode: false
  // Each item: {id, data: {memory, old_memory?}, event: "ADD"|"UPDATE"|"DELETE"|"NOOP"}
  const results = Array.isArray(result) ? result : (result?.results || []);

  return {
    memoriesAdded: results.filter(
      (r: { event?: string }) => r.event === "ADD"
    ).length,
    memoriesUpdated: results.filter(
      (r: { event?: string }) => r.event === "UPDATE"
    ).length,
    memoriesDeleted: results.filter(
      (r: { event?: string }) => r.event === "DELETE"
    ).length,
  };
}

/**
 * Memory item returned from getMemories, with optional metadata.
 */
export interface ContactMemoryItem {
  memory: string;
  createdAt?: string;
}

/**
 * Fetch memories for a contact, filtering by user and optionally contact ID.
 * Returns simplified memory items for use in action generation.
 */
export async function fetchContactMemories(
  contactName: string,
  userId: string,
  contactId?: string,
  limit = 10
): Promise<ContactMemoryItem[]> {
  try {
    const results = await getMemories(contactName, { user_id: userId });
    if (!Array.isArray(results)) return [];

    return results
      .filter(
        (m): m is { memory: string; created_at?: string; metadata?: { contact_id?: string } } =>
          Boolean(m.memory) &&
          (!m.metadata?.contact_id || !contactId || m.metadata.contact_id === contactId)
      )
      .slice(0, limit)
      .map((m) => ({
        memory: m.memory,
        createdAt: m.created_at,
      }));
  } catch (error) {
    console.error("Failed to fetch memories (non-blocking):", error);
    return [];
  }
}

// Re-export memory functions and types for direct use
export {
  addMemories,
  getMemories,
  retrieveMemories,
  searchMemories,
  type Mem0Provider,
  type Mem0ConfigSettings,
};
