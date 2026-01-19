import fs from "fs";
import path from "path";
import { test as base, expect, type Browser, type Page, type TestInfo } from "@playwright/test";

/**
 * E2E Test Fixtures
 *
 * This file provides custom fixtures for E2E tests:
 * - `authenticatedPage`: A page with pre-loaded authentication state
 * - `testData`: Common test data generators
 *
 * Usage:
 *   import { test, expect } from "./fixtures";
 *
 *   test("my authenticated test", async ({ authenticatedPage }) => {
 *     await authenticatedPage.goto("/inbox");
 *     // ... test with authenticated user
 *   });
 */

const AUTH_FILE = path.join(__dirname, "../.auth/user.json");

/**
 * Check if authentication state file exists and is valid
 */
function hasAuthState(): boolean {
  try {
    if (!fs.existsSync(AUTH_FILE)) {
      return false;
    }
    const content = fs.readFileSync(AUTH_FILE, "utf-8");
    const state = JSON.parse(content);
    // Basic validation - should have cookies array
    return Array.isArray(state.cookies);
  } catch {
    return false;
  }
}

/**
 * Test data generators for E2E tests
 */
export const testData = {
  /**
   * Generate a unique test email
   */
  email: () => `test-${Date.now()}@example.com`,

  /**
   * Generate a unique test phone number
   */
  phone: () => `+1555${Math.random().toString().slice(2, 9)}`,

  /**
   * Generate test contact data
   */
  contact: (overrides?: Partial<TestContact>): TestContact => ({
    name: `Test Contact ${Date.now()}`,
    email: testData.email(),
    phone: testData.phone(),
    company: "Test Company",
    notes: "Created by E2E test",
    ...overrides,
  }),

  /**
   * Generate test message data
   */
  message: (overrides?: Partial<TestMessage>): TestMessage => ({
    content: `Test message ${Date.now()}`,
    platform: "imessage",
    ...overrides,
  }),
};

interface TestContact {
  name: string;
  email: string;
  phone: string;
  company: string;
  notes: string;
}

interface TestMessage {
  content: string;
  platform: "imessage" | "gmail" | "slack";
}

/**
 * Extended test fixtures
 */
type TestFixtures = {
  /** Page with authenticated session loaded */
  authenticatedPage: Page;
  /** Whether authentication state is available */
  hasAuth: boolean;
  /** Test data generators */
  testData: typeof testData;
};

/**
 * Worker fixtures needed for browser access
 */
type WorkerFixtures = {
  browser: Browser;
};

/**
 * Extended test with custom fixtures
 *
 * Note: `use` is a Playwright fixture function, not a React hook.
 * ESLint react-hooks/rules-of-hooks is disabled for this block.
 */
/* eslint-disable react-hooks/rules-of-hooks */
export const test = base.extend<TestFixtures, WorkerFixtures>({
  // Fixture: Check if auth state exists
  hasAuth: async ({}, use: (value: boolean) => Promise<void>) => {
    await use(hasAuthState());
  },

  // Fixture: Page with authentication
  authenticatedPage: async (
    { browser, hasAuth }: { browser: Browser; hasAuth: boolean },
    use: (value: Page) => Promise<void>,
    testInfo: TestInfo
  ) => {
    if (!hasAuth) {
      testInfo.skip(true, "No authentication state available. Run auth setup first.");
      return;
    }

    // Create context with saved auth state
    const context = await browser.newContext({
      storageState: AUTH_FILE,
    });
    const page = await context.newPage();

    await use(page);

    await context.close();
  },

  // Fixture: Test data generators
  testData: async ({}, use: (value: typeof testData) => Promise<void>) => {
    await use(testData);
  },
});
/* eslint-enable react-hooks/rules-of-hooks */

export { expect };
