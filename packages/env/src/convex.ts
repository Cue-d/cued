/**
 * Convex runtime environment access
 *
 * Convex functions run in Convex cloud, not Node.js
 * Env vars are set via Convex dashboard, not .env files
 * We provide typed access without heavy validation overhead
 */

type ConvexEnvKey = "WORKOS_CLIENT_ID" | "AI_GATEWAY_API_KEY"

/**
 * Typed access to Convex environment variables
 * Set these in your Convex dashboard under Settings → Environment Variables
 */
export const convexEnv = {
  get WORKOS_CLIENT_ID() {
    return process.env.WORKOS_CLIENT_ID
  },
  get AI_GATEWAY_API_KEY() {
    return process.env.AI_GATEWAY_API_KEY
  },
} as const

/**
 * Get a required Convex environment variable
 * Throws with a clear error message if not set
 *
 * @example
 * const apiKey = requireEnv("AI_GATEWAY_API_KEY")
 */
export function requireEnv(key: ConvexEnvKey): string {
  const value = convexEnv[key]
  if (!value) {
    throw new Error(
      `Missing required Convex environment variable: ${key}\n` +
        `Set this in your Convex dashboard under Settings → Environment Variables`
    )
  }
  return value
}

/**
 * Get an optional Convex environment variable with a default
 */
export function getEnv(key: ConvexEnvKey, defaultValue: string): string {
  return convexEnv[key] ?? defaultValue
}
