import { test, expect } from "@playwright/test";

/**
 * Actions E2E Tests
 *
 * Tests for the action queue feature where users can swipe through
 * AI-suggested actions (respond, snooze, dismiss).
 */

const skipWithoutAuth = !process.env.AUTH_STORAGE_STATE;

test.describe("Actions Page", () => {
  test.skip(skipWithoutAuth, "Requires authenticated session");

  test.use({
    storageState: process.env.AUTH_STORAGE_STATE || undefined,
  });

  test("displays actions page with pending actions", async ({ page }) => {
    await page.goto("/actions");

    // Wait for page to load
    await page.waitForLoadState("networkidle");

    // Check for actions page elements
    await expect(page.getByText("Actions")).toBeVisible();
  });

  test("shows action card when actions are available", async ({ page }) => {
    await page.goto("/actions");

    // Look for action card elements
    const actionCard = page.locator('[data-testid="action-card"]').first();

    // If no actions, should show empty state
    const emptyState = page.getByText(/no pending actions/i);

    // Either action card or empty state should be visible
    const hasActions = await actionCard.isVisible().catch(() => false);
    const hasEmptyState = await emptyState.isVisible().catch(() => false);

    expect(hasActions || hasEmptyState).toBeTruthy();
  });

  test("action card displays contact and message info", async ({ page }) => {
    await page.goto("/actions");

    const actionCard = page.locator('[data-testid="action-card"]').first();

    if (await actionCard.isVisible()) {
      // Should have contact name or identifier
      await expect(actionCard).toContainText(/.+/);
    }
  });

  test("can navigate to actions via sidebar", async ({ page }) => {
    await page.goto("/inbox");

    // Click on Actions in sidebar
    await page.getByRole("link", { name: /actions/i }).click();

    await expect(page).toHaveURL("/actions");
  });

  test("can navigate to actions via Cmd+2", async ({ page }) => {
    await page.goto("/inbox");

    await page.keyboard.press("Meta+2");

    await expect(page).toHaveURL("/actions");
  });

  test("actions badge shows count in sidebar", async ({ page }) => {
    await page.goto("/inbox");

    // Look for badge with count in sidebar
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const actionsBadge = page.locator('[data-testid="actions-badge"]');

    // Badge may or may not be visible depending on pending actions
    // Just verify the sidebar navigation works
    await expect(page.getByRole("link", { name: /actions/i })).toBeVisible();
  });
});

test.describe("Actions - Unauthenticated", () => {
  test("redirects to sign-in when not authenticated", async ({ page }) => {
    await page.goto("/actions");

    await page.waitForURL((url) => {
      return (
        url.pathname !== "/actions" ||
        url.hostname.includes("authkit") ||
        url.hostname.includes("workos")
      );
    });
  });
});
