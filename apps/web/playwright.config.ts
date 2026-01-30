import path from "path";
import { defineConfig, devices } from "@playwright/test";

/**
 * E2E test configuration for Cued web app.
 *
 * Projects:
 * - setup: Handles authentication state setup (runs once before authenticated tests)
 * - chromium: Unauthenticated tests (landing, sign-in redirects)
 * - authenticated: Tests requiring login (inbox, actions, contacts, settings)
 *
 * Run commands:
 *   pnpm --filter web test:e2e              # Run all tests
 *   pnpm --filter web test:e2e:ui           # Interactive UI mode
 *   pnpm --filter web test:e2e --project=chromium  # Only unauthenticated tests
 *
 * To set up authentication:
 *   1. Run: pnpm --filter web dev
 *   2. Open http://localhost:3000 and sign in
 *   3. Run: npx playwright codegen --save-storage=apps/web/.auth/user.json http://localhost:3000
 *   4. Or set PLAYWRIGHT_TEST_EMAIL and PLAYWRIGHT_TEST_PASSWORD env vars
 */

const AUTH_FILE = path.join(__dirname, ".auth/user.json");

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["html"], ["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    // Setup project - runs authentication setup before authenticated tests
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    // Unauthenticated tests - landing page, auth redirects
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /auth\.setup\.ts/,
    },
    // Authenticated tests - uses saved auth state
    {
      name: "authenticated",
      use: {
        ...devices["Desktop Chrome"],
        storageState: AUTH_FILE,
      },
      dependencies: ["setup"],
      testIgnore: /auth\.setup\.ts/,
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
