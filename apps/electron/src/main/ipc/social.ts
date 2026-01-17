/**
 * IPC handlers for social platform scrapers (LinkedIn, Twitter)
 * Task 8.9: Wire Electron IPC to social scraper classes
 */

import { ipcMain, BrowserWindow } from "electron";
import { LinkedInScraper, type LinkedInConnection } from "../sync/linkedin";
import { TwitterScraper, type TwitterUser } from "../sync/twitter";

// Singleton scraper instances to maintain state across calls
let linkedInScraper: LinkedInScraper | null = null;
let twitterScraper: TwitterScraper | null = null;

function getLinkedInScraper(): LinkedInScraper {
  if (!linkedInScraper) {
    linkedInScraper = new LinkedInScraper();
  }
  return linkedInScraper;
}

function getTwitterScraper(): TwitterScraper {
  if (!twitterScraper) {
    twitterScraper = new TwitterScraper();
  }
  return twitterScraper;
}

export interface SocialScrapeResult<T> {
  success: boolean;
  data?: T[];
  error?: string;
  count?: number;
}

export interface SocialStatusResult {
  isLoggedIn: boolean;
  error?: string;
}

/**
 * Set up IPC handlers for social scraping functionality.
 * Call this once during app initialization in main/index.ts
 */
export function setupSocialIpcHandlers(mainWindow: BrowserWindow | null): void {
  // ============================================================================
  // LinkedIn handlers
  // ============================================================================

  /**
   * Check LinkedIn login status by launching headless browser and checking for session.
   */
  ipcMain.handle("social:linkedin:status", async (): Promise<SocialStatusResult> => {
    try {
      const scraper = getLinkedInScraper();
      const isLoggedIn = await scraper.checkLoginStatus();
      return { isLoggedIn };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Social IPC] LinkedIn status check failed:", message);
      return { isLoggedIn: false, error: message };
    }
  });

  /**
   * Open LinkedIn login in visible browser window for user to authenticate.
   * Waits for login completion or timeout (5 minutes).
   */
  ipcMain.handle("social:linkedin:login", async (): Promise<SocialStatusResult> => {
    try {
      const scraper = getLinkedInScraper();
      console.log("[Social IPC] Opening LinkedIn login...");
      const success = await scraper.loginLinkedIn();
      return { isLoggedIn: success };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Social IPC] LinkedIn login failed:", message);
      return { isLoggedIn: false, error: message };
    }
  });

  /**
   * Scrape LinkedIn connections.
   * Requires user to be logged in (call login first if needed).
   */
  ipcMain.handle(
    "social:linkedin:scrape",
    async (
      _event,
      options?: { maxConnections?: number }
    ): Promise<SocialScrapeResult<LinkedInConnection>> => {
      try {
        const scraper = getLinkedInScraper();
        console.log("[Social IPC] Starting LinkedIn scrape...");

        // Notify renderer that scrape is starting
        mainWindow?.webContents.send("social:linkedin:scrapeProgress", {
          status: "starting",
          count: 0,
        });

        const connections = await scraper.scrapeConnections({
          headless: false, // Show browser so user can see progress
          maxConnections: options?.maxConnections ?? 500,
        });

        // Notify renderer of completion
        mainWindow?.webContents.send("social:linkedin:scrapeProgress", {
          status: "complete",
          count: connections.length,
        });

        console.log(`[Social IPC] LinkedIn scrape complete: ${connections.length} connections`);
        return { success: true, data: connections, count: connections.length };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[Social IPC] LinkedIn scrape failed:", message);

        mainWindow?.webContents.send("social:linkedin:scrapeProgress", {
          status: "error",
          error: message,
        });

        return { success: false, error: message };
      }
    }
  );

  // ============================================================================
  // Twitter/X handlers
  // ============================================================================

  /**
   * Check Twitter login status by launching headless browser and checking for session.
   */
  ipcMain.handle("social:twitter:status", async (): Promise<SocialStatusResult> => {
    try {
      const scraper = getTwitterScraper();
      const isLoggedIn = await scraper.checkLoginStatus();
      return { isLoggedIn };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Social IPC] Twitter status check failed:", message);
      return { isLoggedIn: false, error: message };
    }
  });

  /**
   * Open Twitter login in visible browser window for user to authenticate.
   * Waits for login completion or timeout (5 minutes).
   */
  ipcMain.handle("social:twitter:login", async (): Promise<SocialStatusResult> => {
    try {
      const scraper = getTwitterScraper();
      console.log("[Social IPC] Opening Twitter login...");
      const success = await scraper.loginTwitter();
      return { isLoggedIn: success };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Social IPC] Twitter login failed:", message);
      return { isLoggedIn: false, error: message };
    }
  });

  /**
   * Scrape Twitter followers for a given username.
   */
  ipcMain.handle(
    "social:twitter:scrapeFollowers",
    async (
      _event,
      username: string,
      options?: { maxUsers?: number }
    ): Promise<SocialScrapeResult<TwitterUser>> => {
      try {
        const scraper = getTwitterScraper();
        console.log(`[Social IPC] Scraping Twitter followers for @${username}...`);

        mainWindow?.webContents.send("social:twitter:scrapeProgress", {
          status: "starting",
          type: "followers",
          count: 0,
        });

        const followers = await scraper.scrapeFollowers(username, {
          headless: false, // Show browser so user can see progress
          maxUsers: options?.maxUsers ?? 500,
        });

        mainWindow?.webContents.send("social:twitter:scrapeProgress", {
          status: "complete",
          type: "followers",
          count: followers.length,
        });

        console.log(`[Social IPC] Twitter followers scrape complete: ${followers.length} users`);
        return { success: true, data: followers, count: followers.length };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[Social IPC] Twitter followers scrape failed:", message);

        mainWindow?.webContents.send("social:twitter:scrapeProgress", {
          status: "error",
          type: "followers",
          error: message,
        });

        return { success: false, error: message };
      }
    }
  );

  /**
   * Scrape mutual followers (intersection of followers and following) for a given username.
   * This is the most useful for PRM - people who follow you AND you follow back.
   */
  ipcMain.handle(
    "social:twitter:scrapeMutuals",
    async (
      _event,
      username: string,
      options?: { maxUsers?: number }
    ): Promise<SocialScrapeResult<TwitterUser>> => {
      try {
        const scraper = getTwitterScraper();
        console.log(`[Social IPC] Scraping Twitter mutuals for @${username}...`);

        mainWindow?.webContents.send("social:twitter:scrapeProgress", {
          status: "starting",
          type: "mutuals",
          count: 0,
        });

        const mutuals = await scraper.getMutuals(username, {
          headless: false, // Show browser so user can see progress
          maxUsers: options?.maxUsers ?? 500,
        });

        mainWindow?.webContents.send("social:twitter:scrapeProgress", {
          status: "complete",
          type: "mutuals",
          count: mutuals.length,
        });

        console.log(`[Social IPC] Twitter mutuals scrape complete: ${mutuals.length} users`);
        return { success: true, data: mutuals, count: mutuals.length };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[Social IPC] Twitter mutuals scrape failed:", message);

        mainWindow?.webContents.send("social:twitter:scrapeProgress", {
          status: "error",
          type: "mutuals",
          error: message,
        });

        return { success: false, error: message };
      }
    }
  );

  console.log("[Social IPC] Social scraper IPC handlers registered");
}

/**
 * Clean up scraper instances on app quit.
 */
export async function cleanupSocialScrapers(): Promise<void> {
  try {
    if (linkedInScraper) {
      await linkedInScraper.closeBrowser();
      linkedInScraper = null;
    }
    if (twitterScraper) {
      await twitterScraper.closeBrowser();
      twitterScraper = null;
    }
    console.log("[Social IPC] Social scrapers cleaned up");
  } catch (error) {
    console.error("[Social IPC] Error cleaning up scrapers:", error);
  }
}
