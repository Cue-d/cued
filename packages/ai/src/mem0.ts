import { createMem0 } from "@mem0/vercel-ai-provider";

/**
 * Creates a Mem0-wrapped model provider for use with Vercel AI SDK.
 *
 * Usage:
 * ```ts
 * const mem0 = createMem0Provider(userId);
 * const { text } = await generateText({
 *   model: mem0("gpt-4o"),
 *   prompt: "...",
 * });
 * ```
 *
 * @param userId - The PRM user ID for memory scoping
 * @param contactId - Optional contact ID for contact-specific memories
 */
export function createMem0Provider(userId: string, contactId?: string) {
  const mem0UserId = contactId ? `${userId}:${contactId}` : userId;

  return createMem0({
    provider: "openai",
    // API keys read from environment variables:
    // - MEM0_API_KEY for Mem0
    // - OPENAI_API_KEY for OpenAI
    mem0Config: {
      user_id: mem0UserId,
    },
  });
}

// Re-export memory functions for direct use
export { addMemories, getMemories, retrieveMemories } from "@mem0/vercel-ai-provider";
