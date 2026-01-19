import type { Page, Locator } from "@playwright/test";

/**
 * E2E Test Helpers
 *
 * Common utility functions for E2E tests.
 * These helpers encapsulate common actions to make tests more readable
 * and maintainable.
 */

/**
 * Navigation helpers
 */
export const navigation = {
  /**
   * Navigate to inbox and wait for it to load
   */
  async goToInbox(page: Page): Promise<void> {
    await page.goto("/inbox");
    await page.waitForLoadState("networkidle");
  },

  /**
   * Navigate to actions page and wait for it to load
   */
  async goToActions(page: Page): Promise<void> {
    await page.goto("/actions");
    await page.waitForLoadState("networkidle");
  },

  /**
   * Navigate to contacts page and wait for it to load
   */
  async goToContacts(page: Page): Promise<void> {
    await page.goto("/contacts");
    await page.waitForLoadState("networkidle");
  },

  /**
   * Navigate to settings page and wait for it to load
   */
  async goToSettings(page: Page): Promise<void> {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
  },

  /**
   * Navigate to integrations settings
   */
  async goToIntegrations(page: Page): Promise<void> {
    await page.goto("/settings/integrations");
    await page.waitForLoadState("networkidle");
  },

  /**
   * Use keyboard shortcut to navigate
   */
  async navigateWithShortcut(
    page: Page,
    shortcut: "inbox" | "actions" | "agent" | "contacts"
  ): Promise<void> {
    const shortcuts: Record<string, string> = {
      inbox: "Meta+1",
      actions: "Meta+2",
      agent: "Meta+3",
      contacts: "Meta+4",
    };
    await page.keyboard.press(shortcuts[shortcut]);
    await page.waitForLoadState("networkidle");
  },
};

/**
 * Command palette helpers
 */
export const commandPalette = {
  /**
   * Open command palette with Cmd+K
   */
  async open(page: Page): Promise<void> {
    await page.keyboard.press("Meta+k");
    await page.waitForSelector('[role="dialog"]');
  },

  /**
   * Close command palette
   */
  async close(page: Page): Promise<void> {
    await page.keyboard.press("Escape");
  },

  /**
   * Search in command palette
   */
  async search(page: Page, query: string): Promise<void> {
    await this.open(page);
    await page.getByPlaceholder(/search or jump to/i).fill(query);
  },

  /**
   * Select first result in command palette
   */
  async selectFirst(page: Page): Promise<void> {
    await page.keyboard.press("Enter");
  },
};

/**
 * Conversation helpers
 */
export const conversations = {
  /**
   * Get conversation list items
   */
  getList(page: Page): Locator {
    return page.locator('[data-testid="conversation-item"]');
  },

  /**
   * Click on first conversation in list
   */
  async selectFirst(page: Page): Promise<void> {
    const item = this.getList(page).first();
    await item.click();
    await page.waitForLoadState("networkidle");
  },

  /**
   * Filter conversations by platform
   */
  async filterByPlatform(
    page: Page,
    platform: "all" | "imessage" | "gmail" | "slack"
  ): Promise<void> {
    await page.getByRole("button", { name: new RegExp(platform, "i") }).click();
  },

  /**
   * Search conversations
   */
  async search(page: Page, query: string): Promise<void> {
    const searchInput = page.getByPlaceholder(/search/i);
    await searchInput.fill(query);
    await page.waitForLoadState("networkidle");
  },
};

/**
 * Action queue helpers
 */
export const actions = {
  /**
   * Get action card elements
   */
  getCards(page: Page): Locator {
    return page.locator('[data-testid="action-card"]');
  },

  /**
   * Check if empty state is shown
   */
  async hasEmptyState(page: Page): Promise<boolean> {
    const emptyState = page.getByText(/no pending actions|all caught up/i);
    return emptyState.isVisible();
  },

  /**
   * Get the response textarea in the current action card
   */
  getResponseInput(page: Page): Locator {
    return page.locator('[data-testid="action-response-input"]');
  },

  /**
   * Get action buttons
   */
  getButtons(page: Page) {
    return {
      discard: page.getByRole("button", { name: /discard|skip/i }),
      snooze: page.getByRole("button", { name: /snooze/i }),
      send: page.getByRole("button", { name: /send|approve/i }),
    };
  },
};

/**
 * Contact helpers
 */
export const contacts = {
  /**
   * Get contact list items
   */
  getList(page: Page): Locator {
    return page.locator('[data-testid="contact-item"]');
  },

  /**
   * Search contacts
   */
  async search(page: Page, query: string): Promise<void> {
    const searchInput = page.getByPlaceholder(/search contacts/i);
    await searchInput.fill(query);
    await page.waitForLoadState("networkidle");
  },

  /**
   * Click on first contact in list
   */
  async selectFirst(page: Page): Promise<void> {
    const item = this.getList(page).first();
    await item.click();
    await page.waitForLoadState("networkidle");
  },
};

/**
 * Settings helpers
 */
export const settings = {
  /**
   * Get integration cards
   */
  getIntegrationCards(page: Page): Locator {
    return page.locator('[data-testid="integration-card"]');
  },

  /**
   * Get specific integration by name
   */
  getIntegration(page: Page, name: "imessage" | "gmail" | "slack"): Locator {
    const labels: Record<string, string> = {
      imessage: "iMessage",
      gmail: "Gmail",
      slack: "Slack",
    };
    return page.locator(`[data-testid="integration-${name}"]`).or(
      page.getByText(labels[name]).locator("..").locator("..")
    );
  },

  /**
   * Check if integration is connected
   */
  async isConnected(page: Page, name: "imessage" | "gmail" | "slack"): Promise<boolean> {
    const integration = this.getIntegration(page, name);
    const connectedIndicator = integration.getByText(/connected/i);
    return connectedIndicator.isVisible();
  },
};

/**
 * Wait helpers
 */
export const wait = {
  /**
   * Wait for loading to complete
   */
  async forLoading(page: Page): Promise<void> {
    // Wait for any loading spinners to disappear
    const loadingIndicators = page.locator('[data-loading="true"]');
    await loadingIndicators.waitFor({ state: "hidden" }).catch(() => {
      // Ignore if no loading indicators found
    });
    await page.waitForLoadState("networkidle");
  },

  /**
   * Wait for toast notification
   */
  async forToast(page: Page, text?: string | RegExp): Promise<Locator> {
    const toast = text
      ? page.getByText(text)
      : page.locator('[data-sonner-toast]').first();
    await toast.waitFor({ state: "visible" });
    return toast;
  },
};

/**
 * Assert helpers for common checks
 */
export const assert = {
  /**
   * Assert user is on a specific page
   */
  async isOnPage(page: Page, path: string): Promise<void> {
    const url = new URL(page.url());
    if (url.pathname !== path) {
      throw new Error(`Expected to be on ${path}, but was on ${url.pathname}`);
    }
  },

  /**
   * Assert user is authenticated (not redirected to sign-in)
   */
  async isAuthenticated(page: Page): Promise<void> {
    const url = new URL(page.url());
    if (
      url.pathname === "/sign-in" ||
      url.hostname.includes("authkit") ||
      url.hostname.includes("workos")
    ) {
      throw new Error("User is not authenticated - redirected to login");
    }
  },
};
