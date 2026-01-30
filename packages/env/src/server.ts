import { fullServerSchema, type FullServerEnv } from "./schemas.js"

/**
 * Formats Zod validation errors into a readable string
 */
function formatErrors(errors: Record<string, string[] | undefined>): string {
  return Object.entries(errors)
    .filter(([, messages]) => messages && messages.length > 0)
    .map(([key, messages]) => `  - ${key}: ${messages?.join(", ")}`)
    .join("\n")
}

/**
 * Creates and validates the server environment
 * Throws on first access if validation fails
 */
function createEnv(): FullServerEnv {
  const parsed = fullServerSchema.safeParse(process.env)

  if (!parsed.success) {
    const errorMessage = formatErrors(parsed.error.flatten().fieldErrors)
    console.error("❌ Invalid environment variables:\n" + errorMessage)
    throw new Error(
      `Missing or invalid environment variables:\n${errorMessage}\n\nPlease check your .env.local file.`
    )
  }

  return parsed.data
}

// Lazy initialization - validates on first property access
let _env: FullServerEnv | null = null

/**
 * Type-safe server environment variables
 * Validates on first access and throws if required vars are missing
 *
 * @example
 * import { env } from "@prm/env/server"
 * const apiKey = env.AI_GATEWAY_API_KEY
 */
export const env = new Proxy({} as FullServerEnv, {
  get(_, prop: string) {
    if (!_env) {
      _env = createEnv()
    }
    return _env[prop as keyof FullServerEnv]
  },
})

/**
 * Explicitly validate environment variables
 * Call this at app startup for early failure
 */
export function validateEnv(): void {
  if (!_env) {
    _env = createEnv()
  }
}

export type { FullServerEnv as ServerEnv }
