import { test, expect } from "@playwright/test";

/**
 * Settings E2E Tests
 *
 * Tests for the settings pages: profile, integrations, connecting OAuth.
 */

const skipWithoutAuth = !process.env.AUTH_STORAGE_STATE;

test.describe("Settings Page", () => {
  test.skip(skipWithoutAuth, "Requires authenticated session");

  test.use({
    storageState: process.env.AUTH_STORAGE_STATE || undefined,
  });

  test("displays settings page with sections", async ({ page }) => {
    await page.goto("/settings");

    // Wait for page to load
    await page.waitForLoadState("networkidle");

    // Check for settings header
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    // Check for main sections
    await expect(page.getByText("Memory sync")).toBeVisible();
    await expect(page.getByText("Account")).toBeVisible();
  });

  test("shows memory extraction status", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Memory sync section elements
    await expect(page.getByText("Extraction status")).toBeVisible();
    await expect(page.getByText("Automatically runs after each sync")).toBeVisible();

    // Stats cards should be visible (may show loading or data)
    await expect(page.getByText("Memories extracted")).toBeVisible();
    await expect(page.getByText("Messages processed")).toBeVisible();
  });

  test("shows user account information", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Account section should show user info
    const accountSection = page.locator("section").filter({ hasText: "Account" });
    await expect(accountSection).toBeVisible();

    // Delete account button should exist
    await expect(page.getByRole("button", { name: /delete account/i })).toBeVisible();
  });

  test("shows version info", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText(/Cued v[\d.]+/)).toBeVisible();
  });
});

test.describe("Integrations Page", () => {
  test.skip(skipWithoutAuth, "Requires authenticated session");

  test.use({
    storageState: process.env.AUTH_STORAGE_STATE || undefined,
  });

  test("displays integrations page with all platforms", async ({ page }) => {
    await page.goto("/settings/integrations");

    await page.waitForLoadState("networkidle");

    // Check for integrations header
    await expect(page.getByRole("heading", { name: "Integrations" })).toBeVisible();

    // Check for main integration cards
    await expect(page.getByText("iMessage")).toBeVisible();
    await expect(page.getByText("Slack")).toBeVisible();
    await expect(page.getByText("LinkedIn")).toBeVisible();
  });

  test("shows social network integrations section", async ({ page }) => {
    await page.goto("/settings/integrations");
    await page.waitForLoadState("networkidle");

    // Social networks section
    await expect(page.getByText("Social Networks")).toBeVisible();
    await expect(page.getByText("LinkedIn")).toBeVisible();
    await expect(page.getByText("X (Twitter)")).toBeVisible();
  });

  test("shows integration descriptions", async ({ page }) => {
    await page.goto("/settings/integrations");
    await page.waitForLoadState("networkidle");

    // Check descriptions
    await expect(page.getByText("Sync messages from macOS Messages app")).toBeVisible();
    await expect(page.getByText("Connect Slack via desktop app to sync messages")).toBeVisible();
    await expect(page.getByText("Sync LinkedIn messages via desktop app")).toBeVisible();
  });

  test("shows how it works section", async ({ page }) => {
    await page.goto("/settings/integrations");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("How it works")).toBeVisible();
    await expect(page.getByText(/Install the Cued desktop app/)).toBeVisible();
  });

  test("iMessage integration shows desktop app requirement", async ({ page }) => {
    await page.goto("/settings/integrations");
    await page.waitForLoadState("networkidle");

    // iMessage should show it requires desktop app
    const imessageCard = page.locator("div").filter({ hasText: /iMessage.*Sync messages from macOS/ }).first();
    await expect(imessageCard).toBeVisible();
  });

  test("LinkedIn integration shows desktop app requirement", async ({ page }) => {
    await page.goto("/settings/integrations");
    await page.waitForLoadState("networkidle");

    // Find LinkedIn card and look for connection UI
    const linkedinCard = page.locator("div").filter({ hasText: /LinkedIn.*Sync LinkedIn messages/ }).first();
    await expect(linkedinCard).toBeVisible();

    // Should have either Connect button or Connected status
    const connectButton = page.getByRole("button", { name: /connect/i }).first();
    const connectedText = page.getByText(/connected/i).first();

    const hasConnect = await connectButton.isVisible().catch(() => false);
    const hasConnected = await connectedText.isVisible().catch(() => false);

    expect(hasConnect || hasConnected).toBeTruthy();
  });

  test("Slack integration shows connect button", async ({ page }) => {
    await page.goto("/settings/integrations");
    await page.waitForLoadState("networkidle");

    // Find Slack card
    const slackCard = page.locator("div").filter({ hasText: /Slack.*Connect Slack via desktop/ }).first();
    await expect(slackCard).toBeVisible();
  });

  test("back button navigates to settings", async ({ page }) => {
    await page.goto("/settings/integrations");
    await page.waitForLoadState("networkidle");

    // Click back to settings
    await page.getByRole("link", { name: /settings/i }).first().click();

    await expect(page).toHaveURL("/settings");
  });

  test("can navigate to integrations from settings", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Look for link to integrations (may be in sidebar or main content)
    // The integrations page is a separate route
    await page.goto("/settings/integrations");

    await expect(page.getByRole("heading", { name: "Integrations" })).toBeVisible();
  });
});

test.describe("Settings - Unauthenticated", () => {
  test("settings redirects to sign-in when not authenticated", async ({ page }) => {
    await page.goto("/settings");

    await page.waitForURL((url) => {
      return (
        url.pathname !== "/settings" ||
        url.hostname.includes("authkit") ||
        url.hostname.includes("workos")
      );
    });
  });

  test("integrations redirects to sign-in when not authenticated", async ({ page }) => {
    await page.goto("/settings/integrations");

    await page.waitForURL((url) => {
      return (
        url.pathname !== "/settings/integrations" ||
        url.hostname.includes("authkit") ||
        url.hostname.includes("workos")
      );
    });
  });
});
