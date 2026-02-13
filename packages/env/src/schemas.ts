import { z } from "zod"

/**
 * Server-only environment variables (secrets, API keys)
 * These should never be exposed to the client
 */
export const serverSchema = z.object({
  // AI Gateway (supports OIDC auth on Vercel, so optional)
  AI_GATEWAY_API_KEY: z.string().optional(),

  // EnrichLayer (LinkedIn profile enrichment)
  ENRICHLAYER_API_KEY: z.string().optional(),

  // Cron job security
  CRON_SECRET: z.string().optional(),

  // WorkOS Auth
  WORKOS_API_KEY: z.string().optional(),
  WORKOS_COOKIE_PASSWORD: z.string().min(32, "WORKOS_COOKIE_PASSWORD must be at least 32 characters"),
})

/**
 * Shared environment variables (used across multiple apps)
 */
export const sharedSchema = z.object({
  // Convex
  CONVEX_URL: z.string().url().optional(),

  // WorkOS
  WORKOS_CLIENT_ID: z.string().optional(),
})

/**
 * Client-side environment variables (exposed to browser)
 * Must use platform-specific prefixes
 */
export const clientSchema = z.object({
  // Next.js public vars
  NEXT_PUBLIC_CONVEX_URL: z.string().url().optional(),
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
  NEXT_PUBLIC_WORKOS_REDIRECT_URI: z.string().url().optional(),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().optional(),

  // Expo public vars
  EXPO_PUBLIC_CONVEX_URL: z.string().url().optional(),
  EXPO_PUBLIC_WORKOS_CLIENT_ID: z.string().optional(),
  EXPO_PUBLIC_API_URL: z.string().url().optional(),
  EXPO_PUBLIC_POSTHOG_KEY: z.string().optional(),
  EXPO_PUBLIC_POSTHOG_HOST: z.string().optional(),
})

/**
 * Electron-specific environment variables
 */
export const electronSchema = z.object({
  CONVEX_URL: z.string().url("CONVEX_URL must be a valid URL"),
  WORKOS_CLIENT_ID: z.string().min(1, "WORKOS_CLIENT_ID is required"),
  API_BASE_URL: z.string().url().optional(),
  SIGNAL_ACCOUNT: z.string().optional(),
  SIGNAL_CLI_PATH: z.string().optional(),
  NODE_ENV: z.enum(["development", "production", "test"]).optional(),
  POSTHOG_KEY: z.string().optional(),
  POSTHOG_HOST: z.string().optional(),
})

/**
 * Combined schema for full server environment
 */
export const fullServerSchema = serverSchema.merge(sharedSchema).merge(clientSchema)

export type ServerEnv = z.infer<typeof serverSchema>
export type SharedEnv = z.infer<typeof sharedSchema>
export type ClientEnv = z.infer<typeof clientSchema>
export type ElectronEnv = z.infer<typeof electronSchema>
export type FullServerEnv = z.infer<typeof fullServerSchema>
