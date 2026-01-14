import { createOpenAI } from "@ai-sdk/openai";

/**
 * OpenAI provider instance configured for PRM.
 * Uses OPENAI_API_KEY from environment.
 * Supports optional ZDR (Zero Data Retention) endpoint for production.
 */
export const openai = createOpenAI({
  // Use ZDR endpoint in production if configured
  baseURL: process.env.OPENAI_BASE_URL,
  // API key from environment (defaults to OPENAI_API_KEY)
  apiKey: process.env.OPENAI_API_KEY,
});

// Default model for assistant chat
export const DEFAULT_MODEL = "gpt-5-mini";

// Faster model for structured extraction tasks
export const FAST_MODEL = "gpt-5-nano";
