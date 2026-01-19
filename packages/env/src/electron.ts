import { electronSchema, type ElectronEnv } from "./schemas.js"

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
 * Creates and validates the Electron environment
 */
function createElectronEnv(): ElectronEnv {
  const parsed = electronSchema.safeParse(process.env)

  if (!parsed.success) {
    const errorMessage = formatErrors(parsed.error.flatten().fieldErrors)
    console.error("❌ Invalid Electron environment variables:\n" + errorMessage)
    throw new Error(
      `Missing or invalid environment variables:\n${errorMessage}\n\n` +
        `Please ensure your .env file contains:\n` +
        `  CONVEX_URL=https://your-project.convex.cloud\n` +
        `  WORKOS_CLIENT_ID=client_xxx`
    )
  }

  return parsed.data
}

// Lazy initialization
let _env: ElectronEnv | null = null

/**
 * Type-safe Electron environment variables
 * Validates on first access and throws if required vars are missing
 *
 * @example
 * import { electronEnv } from "@prm/env/electron"
 * const convexUrl = electronEnv.CONVEX_URL
 */
export const electronEnv = new Proxy({} as ElectronEnv, {
  get(_, prop: string) {
    if (!_env) {
      _env = createElectronEnv()
    }
    return _env[prop as keyof ElectronEnv]
  },
})

/**
 * Explicitly validate Electron environment variables
 * Call this at app startup for early failure
 */
export function validateElectronEnv(): void {
  if (!_env) {
    _env = createElectronEnv()
  }
}

export type { ElectronEnv }
