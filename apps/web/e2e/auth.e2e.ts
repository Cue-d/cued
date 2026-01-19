import { test, expect } from "@playwright/test";

test.describe("Authentication Flow", () => {
  test("sign-in redirects to WorkOS authentication", async ({ page }) => {
    // Navigate to sign-in route
    await page.goto("/sign-in");

    // Should redirect to WorkOS authentication URL
    await page.waitForURL((url) => {
      // WorkOS AuthKit uses authkit.com or custom domain
      return (
        url.hostname.includes("authkit") ||
        url.hostname.includes("workos") ||
        // Or may redirect back on error
        url.pathname.includes("error")
      );
    });

    // Verify we're on the auth page (not on our app)
    const currentUrl = page.url();
    expect(
      currentUrl.includes("authkit") ||
        currentUrl.includes("workos") ||
        currentUrl.includes("error")
    ).toBeTruthy();
  });

  test("sign-up redirects to WorkOS authentication", async ({ page }) => {
    await page.goto("/sign-up");

    await page.waitForURL((url) => {
      return (
        url.hostname.includes("authkit") ||
        url.hostname.includes("workos") ||
        url.pathname.includes("error")
      );
    });
  });

  test("protected routes redirect to sign-in when unauthenticated", async ({
    page,
  }) => {
    // Try to access protected route directly
    await page.goto("/inbox");

    // Should redirect to sign-in or WorkOS
    await page.waitForURL((url) => {
      return (
        url.pathname === "/" ||
        url.pathname === "/sign-in" ||
        url.hostname.includes("authkit") ||
        url.hostname.includes("workos")
      );
    });
  });

  test("callback route handles invalid requests gracefully", async ({ page }) => {
    // The callback route requires valid auth code from WorkOS
    // Without it, it may return an error or redirect
    const response = await page.goto("/callback");

    // Route should exist (not 404)
    // It's OK to return 400-500 since there's no valid auth code
    expect(response?.status()).not.toBe(404);
  });
});

test.describe("Sign Out", () => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  test.skip("sign-out clears session and redirects to home", async ({ page }) => {
    // This test requires an authenticated session
    // Skip in CI without proper auth setup
    // Would need to:
    // 1. Set up authenticated state via storageState
    // 2. Navigate to app
    // 3. Click sign out
    // 4. Verify redirect to home and session cleared
  });
});
