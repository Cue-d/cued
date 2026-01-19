import { z } from "zod"

/**
 * Client environment schema
 * Only includes vars with NEXT_PUBLIC_ or EXPO_PUBLIC_ prefix
 */
const clientEnvSchema = z.object({
  // Next.js public vars
  NEXT_PUBLIC_CONVEX_URL: z.string().url().optional(),
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
  NEXT_PUBLIC_WORKOS_REDIRECT_URI: z.string().url().optional(),

  // Expo public vars
  EXPO_PUBLIC_CONVEX_URL: z.string().url().optional(),
  EXPO_PUBLIC_WORKOS_CLIENT_ID: z.string().optional(),
  EXPO_PUBLIC_API_URL: z.string().url().optional(),
})

export type ClientEnv = z.infer<typeof clientEnvSchema>

/**
 * Creates validated client environment
 * These vars are inlined at build time by Next.js/Expo
 */
function createClientEnv(): ClientEnv {
  // Build an object with only the public vars
  // Framework bundlers replace these at build time
  const envObject = {
    NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI,
    EXPO_PUBLIC_CONVEX_URL: process.env.EXPO_PUBLIC_CONVEX_URL,
    EXPO_PUBLIC_WORKOS_CLIENT_ID: process.env.EXPO_PUBLIC_WORKOS_CLIENT_ID,
    EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
  }

  const parsed = clientEnvSchema.safeParse(envObject)

  if (!parsed.success) {
    console.error("❌ Invalid client environment variables:", parsed.error.flatten().fieldErrors)
    throw new Error("Missing or invalid client environment variables")
  }

  return parsed.data
}

/**
 * Type-safe client environment variables
 * Validated at module load time (build time for Next.js/Expo)
 *
 * @example
 * import { clientEnv } from "@prm/env/client"
 * const convexUrl = clientEnv.NEXT_PUBLIC_CONVEX_URL
 */
export const clientEnv = createClientEnv()

/**
 * Get the Convex URL for the current platform
 * Returns NEXT_PUBLIC_CONVEX_URL or EXPO_PUBLIC_CONVEX_URL
 */
export function getConvexUrl(): string {
  const url = clientEnv.NEXT_PUBLIC_CONVEX_URL || clientEnv.EXPO_PUBLIC_CONVEX_URL
  if (!url) {
    throw new Error(
      "Missing Convex URL. Set NEXT_PUBLIC_CONVEX_URL (web) or EXPO_PUBLIC_CONVEX_URL (mobile)"
    )
  }
  return url
}
