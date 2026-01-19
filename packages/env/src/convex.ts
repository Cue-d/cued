/**
 * Convex runtime environment access
 *
 * Convex functions run in Convex cloud, not Node.js
 * Env vars are set via Convex dashboard, not .env files
 * We provide typed access without heavy validation overhead
 */

type ConvexEnvKey = "NANGO_SECRET_KEY" | "WORKOS_CLIENT_ID" | "OPENAI_API_KEY" | "OPENAI_BASE_URL"

/**
 * Typed access to Convex environment variables
 * Set these in your Convex dashboard under Settings → Environment Variables
 */
export const convexEnv = {
  get NANGO_SECRET_KEY() {
    return process.env.NANGO_SECRET_KEY
  },
  get WORKOS_CLIENT_ID() {
    return process.env.WORKOS_CLIENT_ID
  },
  get OPENAI_API_KEY() {
    return process.env.OPENAI_API_KEY
  },
  get OPENAI_BASE_URL() {
    return process.env.OPENAI_BASE_URL
  },
} as const

/**
 * Get a required Convex environment variable
 * Throws with a clear error message if not set
 *
 * @example
 * const apiKey = requireEnv("NANGO_SECRET_KEY")
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
