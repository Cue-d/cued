import path from "path";
import { test as setup, expect } from "@playwright/test";

/**
 * Authentication Setup for E2E Tests
 *
 * This file handles authentication state setup for E2E tests.
 * Since PRM uses WorkOS AuthKit (external OAuth), we have two approaches:
 *
 * 1. Manual auth state capture (recommended for local development):
 *    - Run the app, sign in manually
 *    - Use browser DevTools to export cookies/storage
 *    - Save to .auth/user.json
 *
 * 2. Automated auth (if WorkOS test accounts are configured):
 *    - Uses PLAYWRIGHT_TEST_EMAIL and PLAYWRIGHT_TEST_PASSWORD env vars
 *    - Navigates through WorkOS login flow
 *
 * To generate auth state manually:
 *   1. Run: pnpm --filter web dev
 *   2. Open http://localhost:3000 and sign in
 *   3. Run: npx playwright codegen --save-storage=.auth/user.json http://localhost:3000
 *   4. Close browser when done
 *
 * The auth state file is gitignored and should not be committed.
 */

const AUTH_FILE = path.join(__dirname, "../.auth/user.json");

/**
 * Setup project that runs before authenticated tests.
 * Stores browser state (cookies, localStorage) for reuse.
 */
setup("authenticate", async ({ page }) => {
  // Check if we have test credentials
  const testEmail = process.env.PLAYWRIGHT_TEST_EMAIL;
  const testPassword = process.env.PLAYWRIGHT_TEST_PASSWORD;

  if (!testEmail || !testPassword) {
    // Skip automated auth - tests will use pre-existing auth file if available
    // or skip tests that require authentication
    console.log(
      "PLAYWRIGHT_TEST_EMAIL and PLAYWRIGHT_TEST_PASSWORD not set. " +
        "Skipping automated auth setup. " +
        "Authenticated tests will be skipped unless .auth/user.json exists."
    );

    // Try to verify existing auth file works
    try {
      await page.goto("/inbox");
      await page.waitForLoadState("networkidle");

      // If we can access inbox, auth state is valid
      const url = page.url();
      if (!url.includes("/inbox")) {
        console.log("No valid auth state found. Authenticated tests will be skipped.");
        return;
      }
    } catch {
      console.log("Could not verify auth state. Authenticated tests will be skipped.");
      return;
    }

    return;
  }

  // Automated authentication flow
  console.log("Attempting automated authentication with WorkOS...");

  // Navigate to sign-in
  await page.goto("/sign-in");

  // Wait for WorkOS login page
  await page.waitForURL((url) => {
    return url.hostname.includes("authkit") || url.hostname.includes("workos");
  });

  // Fill in WorkOS login form
  // Note: WorkOS UI may vary based on configuration (email+password, SSO, etc.)
  const emailInput = page.getByLabel(/email/i);
  if (await emailInput.isVisible()) {
    await emailInput.fill(testEmail);
  }

  const passwordInput = page.getByLabel(/password/i);
  if (await passwordInput.isVisible()) {
    await passwordInput.fill(testPassword);
  }

  // Submit the form
  const submitButton = page.getByRole("button", { name: /sign in|continue|submit/i });
  if (await submitButton.isVisible()) {
    await submitButton.click();
  }

  // Wait for redirect back to app
  await page.waitForURL((url) => {
    return url.hostname === "localhost" && url.pathname !== "/sign-in";
  });

  // Verify we're authenticated by accessing a protected route
  await page.goto("/inbox");
  await expect(page.getByText("Inbox")).toBeVisible();

  // Save authentication state
  await page.context().storageState({ path: AUTH_FILE });
  console.log(`Auth state saved to ${AUTH_FILE}`);
});
