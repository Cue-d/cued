import { test, expect } from "@playwright/test";

test.describe("Landing Page", () => {
  test("displays hero section with correct content", async ({ page }) => {
    await page.goto("/");

    // Check hero heading
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "Your personal"
    );

    // Check beta badge
    await expect(page.getByText("Now in beta")).toBeVisible();

    // Check description
    await expect(
      page.getByText("Connect your communications across")
    ).toBeVisible();
  });

  test("displays Get Started and Sign In buttons", async ({ page }) => {
    await page.goto("/");

    // Get buttons in main section (not nav)
    const getStartedLink = page.getByRole("main").getByRole("link", { name: "Get Started" });
    const signInLink = page.getByRole("main").getByRole("link", { name: "Sign In" });

    await expect(getStartedLink).toBeVisible();
    await expect(signInLink).toBeVisible();

    // Verify correct hrefs
    await expect(getStartedLink).toHaveAttribute("href", "/sign-up");
    await expect(signInLink).toHaveAttribute("href", "/sign-in");
  });

  test("displays feature sections", async ({ page }) => {
    await page.goto("/");

    // Check all three feature titles
    await expect(page.getByText("Unified Inbox")).toBeVisible();
    await expect(page.getByText("AI-Powered Actions")).toBeVisible();
    await expect(page.getByText("Contact Memory")).toBeVisible();
  });

  test("Get Started button navigates to sign-up", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("main").getByRole("link", { name: "Get Started" }).click();

    // Should redirect to WorkOS (external URL)
    // Just verify navigation was initiated
    await page.waitForURL((url) => {
      // Either still loading sign-up or redirected to WorkOS
      return (
        url.pathname === "/sign-up" ||
        url.hostname.includes("workos") ||
        url.hostname.includes("authkit")
      );
    });
  });

  test("Sign In button navigates to sign-in", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("main").getByRole("link", { name: "Sign In" }).click();

    // Should redirect to WorkOS (external URL)
    await page.waitForURL((url) => {
      return (
        url.pathname === "/sign-in" ||
        url.hostname.includes("workos") ||
        url.hostname.includes("authkit")
      );
    });
  });
});
