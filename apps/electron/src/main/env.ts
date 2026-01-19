/**
 * Load environment variables from monorepo root .env.local
 * This must be imported FIRST before any other modules that use env vars
 */
import { config } from "dotenv";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

// Try multiple locations for .env.local
const possibleRoots = [
  // When running pnpm dev from monorepo root
  process.cwd(),
  // When running from apps/electron directory
  resolve(process.cwd(), "../.."),
];

for (const rootDir of possibleRoots) {
  const envPath = resolve(rootDir, ".env.local");
  if (existsSync(envPath)) {
    config({ path: envPath });
    console.log("[Env] Loaded:", envPath);
    break;
  }
}
