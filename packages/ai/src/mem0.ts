import {
  createMem0,
  addMemories,
  getMemories,
  retrieveMemories,
  searchMemories,
  type Mem0Provider,
  type Mem0ConfigSettings,
} from "@mem0/vercel-ai-provider";
import { buildMemoryInstructions } from "./prompts/memory.js";

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
  const result = await addMemories(
    conversationText as unknown as Parameters<typeof addMemories>[0],
    {
      user_id: userId,
      metadata: { contact_id: contactId },
      custom_instructions: customInstructions,
    } as Mem0ConfigSettings
  );

  const results = result?.results || [];
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

// Re-export memory functions and types for direct use
export {
  addMemories,
  getMemories,
  retrieveMemories,
  searchMemories,
  type Mem0Provider,
  type Mem0ConfigSettings,
};
