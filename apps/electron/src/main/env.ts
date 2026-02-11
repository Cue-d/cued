/**
 * Populate process.env with required environment variables.
 *
 * In production builds, Vite injects __ELECTRON_ENV__ at build time via `define`.
 * In development, we fall back to dotenv to load .env.local from the monorepo root.
 *
 * This must be imported FIRST before any other modules that use env vars.
 */

declare const __ELECTRON_ENV__: Record<string, string | undefined>;

// 1. Try build-time injected env vars (works in both dev and production)
try {
  const injected = __ELECTRON_ENV__;
  for (const [key, value] of Object.entries(injected)) {
    if (value && !process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {
  // __ELECTRON_ENV__ not defined (e.g., running raw ts-node) — fall through
}

// 2. In development, also try dotenv as a fallback
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dotenv = require("dotenv");
  const { resolve } = require("node:path");
  const { existsSync } = require("node:fs");

  const possibleRoots = [process.cwd(), resolve(process.cwd(), "../..")];

  for (const rootDir of possibleRoots) {
    const envPath = resolve(rootDir, ".env.local");
    if (existsSync(envPath)) {
      dotenv.config({ path: envPath });
      console.log("[Env] Loaded:", envPath);
      break;
    }
  }
} catch {
  // dotenv not available in production — expected
}
