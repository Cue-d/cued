import { test, expect } from "@playwright/test";

/**
 * Inbox E2E Tests
 *
 * These tests require authentication. To run them:
 * 1. Create a test user in WorkOS
 * 2. Generate auth storage state: pnpm --filter web test:e2e:setup
 * 3. Run tests with auth: pnpm --filter web test:e2e --project=authenticated
 *
 * For CI, these tests are skipped unless AUTH_STORAGE_STATE env var is set.
 */

const skipWithoutAuth = !process.env.AUTH_STORAGE_STATE;

test.describe("Inbox Navigation", () => {
  test.skip(skipWithoutAuth, "Requires authenticated session");

  test.use({
    storageState: process.env.AUTH_STORAGE_STATE || undefined,
  });

  test("displays inbox page with conversation list", async ({ page }) => {
    await page.goto("/inbox");

    // Wait for page to load
    await page.waitForLoadState("networkidle");

    // Check for inbox elements
    await expect(page.getByText("Inbox")).toBeVisible();
  });

  test("shows platform filter buttons", async ({ page }) => {
    await page.goto("/inbox");

    // Check for filter buttons
    await expect(page.getByRole("button", { name: /all/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /imessage/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /slack/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /linkedin/i })).toBeVisible();
  });

  test("filters conversations by platform", async ({ page }) => {
    await page.goto("/inbox");

    // Click iMessage filter
    await page.getByRole("button", { name: /imessage/i }).click();

    // URL should update with platform param
    await expect(page).toHaveURL(/platform=imessage/);

    // Click All to reset
    await page.getByRole("button", { name: /all/i }).click();
    await expect(page).not.toHaveURL(/platform=/);
  });

  test("selecting a conversation shows message thread", async ({ page }) => {
    await page.goto("/inbox");

    // Click on first conversation if available
    const conversationItem = page.locator('[data-testid="conversation-item"]').first();

    if (await conversationItem.isVisible()) {
      await conversationItem.click();

      // Should show message thread
      await expect(page.locator('[data-testid="message-thread"]')).toBeVisible();
    }
  });

  test("command palette opens with Cmd+K", async ({ page }) => {
    await page.goto("/inbox");

    // Press Cmd+K (or Ctrl+K on Windows/Linux)
    await page.keyboard.press("Meta+k");

    // Command dialog should be visible
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByPlaceholder(/search or jump to/i)).toBeVisible();
  });

  test("keyboard shortcuts navigate to different pages", async ({ page }) => {
    await page.goto("/inbox");

    // Press Cmd+2 for Actions
    await page.keyboard.press("Meta+2");
    await expect(page).toHaveURL("/actions");

    // Press Cmd+1 to go back to Inbox
    await page.keyboard.press("Meta+1");
    await expect(page).toHaveURL("/inbox");

    // Press Cmd+4 for Contacts
    await page.keyboard.press("Meta+4");
    await expect(page).toHaveURL("/contacts");
  });
});

test.describe("Inbox - Unauthenticated", () => {
  test("redirects to sign-in when not authenticated", async ({ page }) => {
    await page.goto("/inbox");

    // Should redirect away from inbox
    await page.waitForURL((url) => {
      return (
        url.pathname !== "/inbox" ||
        url.hostname.includes("authkit") ||
        url.hostname.includes("workos")
      );
    });
  });
});
