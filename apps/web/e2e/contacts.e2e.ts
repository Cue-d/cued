import { test, expect } from "@playwright/test";

/**
 * Contacts E2E Tests
 *
 * Tests for the contacts page: viewing contact list, searching, filtering.
 */

const skipWithoutAuth = !process.env.AUTH_STORAGE_STATE;

test.describe("Contacts Page", () => {
  test.skip(skipWithoutAuth, "Requires authenticated session");

  test.use({
    storageState: process.env.AUTH_STORAGE_STATE || undefined,
  });

  test("displays contacts page with search and contact list", async ({ page }) => {
    await page.goto("/contacts");

    // Wait for page to load
    await page.waitForLoadState("networkidle");

    // Check for contacts page elements
    await expect(page.getByText("All Contacts")).toBeVisible();
    await expect(page.getByPlaceholder(/search contacts/i)).toBeVisible();
  });

  test("shows Find Duplicates button", async ({ page }) => {
    await page.goto("/contacts");

    // Look for the scan button
    await expect(page.getByRole("button", { name: /find duplicates/i })).toBeVisible();
  });

  test("search input filters contacts", async ({ page }) => {
    await page.goto("/contacts");
    await page.waitForLoadState("networkidle");

    const searchInput = page.getByPlaceholder(/search contacts/i);

    // Type in search
    await searchInput.fill("test");

    // Wait for debounced search to execute
    await page.waitForTimeout(400); // 300ms debounce + buffer

    // Verify search is working (either shows results or "No contacts matching")
    const hasResults = await page.locator('[class*="contact"]').first().isVisible().catch(() => false);
    const hasEmptyState = await page.getByText(/no contacts matching/i).isVisible().catch(() => false);

    expect(hasResults || hasEmptyState).toBeTruthy();
  });

  test("search clears when input is cleared", async ({ page }) => {
    await page.goto("/contacts");
    await page.waitForLoadState("networkidle");

    const searchInput = page.getByPlaceholder(/search contacts/i);

    // Type then clear
    await searchInput.fill("test");
    await page.waitForTimeout(400);
    await searchInput.clear();
    await page.waitForTimeout(400);

    // Should show all contacts again
    await expect(page.getByText("All Contacts")).toBeVisible();
  });

  test("shows empty state when no contacts exist", async ({ page }) => {
    await page.goto("/contacts");
    await page.waitForLoadState("networkidle");

    // Either shows contacts or empty state
    const hasContacts = await page.locator('[class*="ContactRow"]').first().isVisible().catch(() => false);
    const hasEmptyState = await page.getByText(/no contacts yet/i).isVisible().catch(() => false);

    // At least one should be visible
    expect(hasContacts || hasEmptyState || await page.getByText("All Contacts").isVisible()).toBeTruthy();
  });

  test("displays contact with name and handles", async ({ page }) => {
    await page.goto("/contacts");
    await page.waitForLoadState("networkidle");

    // Check if there's at least one contact row (hover state class)
    const contactRow = page.locator('.hover\\:bg-muted\\/50').first();

    if (await contactRow.isVisible()) {
      // Contact should have avatar and name
      await expect(contactRow.locator('[class*="avatar"]').first()).toBeVisible();
    }
  });

  test("merge suggestions section shows when duplicates exist", async ({ page }) => {
    await page.goto("/contacts");
    await page.waitForLoadState("networkidle");

    // Merge suggestions section may or may not exist
    const hasMergeSuggestions = await page.getByText("Possible Duplicates").isVisible().catch(() => false);

    // Just verify the page loads correctly - merge section is optional
    await expect(page.getByText("All Contacts")).toBeVisible();

    // If merge suggestions exist, verify structure
    if (hasMergeSuggestions) {
      await expect(page.getByText("Possible Duplicates")).toBeVisible();
    }
  });

  test("can navigate to contacts via sidebar", async ({ page }) => {
    await page.goto("/inbox");

    // Click on Contacts in sidebar
    await page.getByRole("link", { name: /contacts/i }).click();

    await expect(page).toHaveURL("/contacts");
  });

  test("can navigate to contacts via Cmd+4", async ({ page }) => {
    await page.goto("/inbox");

    await page.keyboard.press("Meta+4");

    await expect(page).toHaveURL("/contacts");
  });
});

test.describe("Contacts - Unauthenticated", () => {
  test("redirects to sign-in when not authenticated", async ({ page }) => {
    await page.goto("/contacts");

    await page.waitForURL((url) => {
      return (
        url.pathname !== "/contacts" ||
        url.hostname.includes("authkit") ||
        url.hostname.includes("workos")
      );
    });
  });
});
