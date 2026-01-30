import { createGateway } from "@ai-sdk/gateway";

/**
 * Vercel AI Gateway provider instance configured for Cued.
 * Uses AI_GATEWAY_API_KEY from environment.
 * Supports OIDC authentication on Vercel deployments (no API key needed).
 *
 * Note: Uses process.env directly because this module is bundled by Convex
 * which runs in a different runtime environment.
 */
export const gateway = createGateway({
  // API key from environment (defaults to AI_GATEWAY_API_KEY)
  // On Vercel, OIDC auth is used automatically if no key is provided
  apiKey: process.env.AI_GATEWAY_API_KEY,
});

// Single model for all AI tasks - Kimi K2.5
export const MODEL = "moonshotai/kimi-k2.5";
