import {
  createMem0,
  addMemories,
  getMemories,
  retrieveMemories,
  searchMemories,
  type Mem0Provider,
  type Mem0ConfigSettings,
} from "@mem0/vercel-ai-provider";

/**
 * Creates a Mem0-wrapped model provider for use with Vercel AI SDK.
 * Does NOT bind user_id at creation - pass it per-request when calling the model.
 *
 * Usage:
 * ```ts
 * const mem0 = createMem0Provider();
 * const { text } = await generateText({
 *   model: mem0("gpt-4o", { user_id: userId }),
 *   prompt: "...",
 * });
 * ```
 */
export function createMem0Provider(): Mem0Provider {
  return createMem0({
    provider: "openai",
    // API keys read from environment variables:
    // - MEM0_API_KEY for Mem0
    // - OPENAI_API_KEY for OpenAI
  });
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
