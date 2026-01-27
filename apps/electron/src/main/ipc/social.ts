/**
 * IPC handlers for social platform scrapers (LinkedIn, Twitter)
 * Task 8.9: Wire Electron IPC to social scraper classes
 * Task 4.1: Add LinkedIn messaging IPC handlers
 */

import { ipcMain, BrowserWindow } from "electron";
import {
  LinkedInScraper,
  getLinkedInSyncManager,
  type LinkedInConnection,
  type LinkedInSyncProgress,
} from "../platforms/linkedin";
import {
  getSlackSyncManager,
  getAllSlackSyncManagers,
  removeSlackSyncManager,
  initializeAllSlackSyncManagers,
  openSlackLogin,
  clearSlackSession,
  getSlackCredentials,
  getAllSlackCredentials,
  clearSlackCredentials,
  deleteSlackCredentials,
  type SlackSyncProgress,
} from "../platforms/slack";
import { getAdapter } from "../adapters";
import { getValidAccessToken, forceRefreshToken } from "../auth";
import { electronEnv } from "@prm/env/electron";

// Singleton scraper instance to maintain state across calls
let linkedInScraper: LinkedInScraper | null = null;

/**
 * Get the singleton LinkedInScraper instance.
 * Ensures browser operations are serialized across all callers.
 */
export function getLinkedInScraper(): LinkedInScraper {
  if (!linkedInScraper) {
    linkedInScraper = new LinkedInScraper();
  }
  return linkedInScraper;
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

// LinkedIn messaging types
export interface LinkedInMessagingStatusResult {
  connected: boolean;
  syncProgress?: LinkedInSyncProgress;
  error?: string;
}

export interface LinkedInSyncResult {
  success: boolean;
  error?: string;
}

export interface LinkedInSendMessageResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface SocialSyncResult {
  success: boolean;
  totalContacts?: number;
  newContacts?: number;
  updatedContacts?: number;
  error?: string;
}

// Slack types
export interface SlackWorkspaceInfo {
  teamId: string;
  teamName: string;
  userId: string;
  isConnected: boolean;
  syncProgress?: SlackSyncProgress;
}

export interface SlackStatusResult {
  isConnected: boolean;
  teamName?: string;
  workspaces?: SlackWorkspaceInfo[];
  error?: string;
}

export interface SlackLoginResult {
  success: boolean;
  teamId?: string;
  teamName?: string;
  error?: string;
}

export interface SlackSyncStatusResult {
  connected: boolean;
  syncProgress?: SlackSyncProgress;
  workspaces?: SlackWorkspaceInfo[];
  error?: string;
}

export interface SlackSyncResult {
  success: boolean;
  error?: string;
}

/**
 * Sync scraped social contacts to the backend.
 * Maps connections to SocialContact format and POSTs to /api/sync/social.
 * Retries with fresh token on auth errors.
 */
async function syncLinkedInContactsToBackend(
  connections: LinkedInConnection[],
  retryCount = 0
): Promise<SocialSyncResult> {
  const MAX_RETRIES = 2;

  try {
    // Force refresh token if this is a retry
    const token = await getValidAccessToken(retryCount > 0);
    if (!token) {
      return { success: false, error: "No auth token available" };
    }

    const baseUrl = electronEnv.API_BASE_URL || "http://localhost:3000";

    // Map LinkedInConnection to SocialContact format expected by API
    const contacts = connections.map((conn) => ({
      name: conn.name,
      handle: conn.profileUrl,
      profileUrl: conn.profileUrl,
      headline: conn.headline,
      platform: "linkedin" as const,
      profileId: conn.profileId,
    }));

    const response = await fetch(`${baseUrl}/api/sync/social`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        platform: "linkedin",
        contacts,
        syncedAt: Date.now(),
      }),
    });

    // Check for auth errors and retry with fresh token
    if (response.status === 401 && retryCount < MAX_RETRIES) {
      return syncLinkedInContactsToBackend(connections, retryCount + 1);
    }

    if (!response.ok) {
      const text = await response.text();
      // Retry on auth-related HTML responses (redirects to login page)
      if (text.includes("<!DOCTYPE") && retryCount < MAX_RETRIES) {
        return syncLinkedInContactsToBackend(connections, retryCount + 1);
      }
      return {
        success: false,
        error: `API error: ${response.status} - ${text.slice(0, 100)}`,
      };
    }

    // Check content-type before parsing JSON
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      const htmlBody = await response.text();
      if (htmlBody.includes("404") || htmlBody.includes("Not Found")) {
        return { success: false, error: "API route not found (404)" };
      }
      // Retry with fresh token - HTML response usually means auth redirect
      if (retryCount < MAX_RETRIES) {
        return syncLinkedInContactsToBackend(connections, retryCount + 1);
      }
      return { success: false, error: "Invalid response format" };
    }

    const result = await response.json();

    return {
      success: true,
      totalContacts: result.totalContacts,
      newContacts: result.newContacts,
      updatedContacts: result.updatedContacts,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[Social IPC] LinkedIn sync to backend failed:", message);
    return { success: false, error: message };
  }
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
      const success = await scraper.loginLinkedIn();
      return { isLoggedIn: success };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Social IPC] LinkedIn login failed:", message);
      return { isLoggedIn: false, error: message };
    }
  });

  /**
   * Scrape LinkedIn connections using the API (faster and more reliable than Playwright).
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

        // Notify renderer that scrape is starting
        mainWindow?.webContents.send("social:linkedin:scrapeProgress", {
          status: "starting",
          count: 0,
        });

        // Use API-based scraping instead of Playwright DOM scraping
        // Pass maxConnections only if explicitly provided (undefined = fetch all)
        const apiConnections = await scraper.scrapeConnectionsViaApi({
          maxConnections: options?.maxConnections,
        });

        // Convert API Connection[] to LinkedInConnection[] format for UI compatibility
        const connections: LinkedInConnection[] = apiConnections.map((conn) => ({
          name: `${conn.firstName} ${conn.lastName}`.trim(),
          profileUrl: conn.profileUrl,
          headline: conn.headline ?? null,
          connectedDate: conn.connectionDate ?? null,
          profileId: conn.profileId,
        }));

        // Sync connections to backend
        mainWindow?.webContents.send("social:linkedin:scrapeProgress", {
          status: "syncing",
          count: connections.length,
        });

        const syncResult = await syncLinkedInContactsToBackend(connections);
        if (!syncResult.success) {
          console.warn(`[Social IPC] LinkedIn backend sync failed: ${syncResult.error}`);
          // Continue even if sync fails - scrape was successful
        }

        // Notify renderer of completion
        mainWindow?.webContents.send("social:linkedin:scrapeProgress", {
          status: "complete",
          count: connections.length,
          syncResult: syncResult.success
            ? {
                newContacts: syncResult.newContacts,
                updatedContacts: syncResult.updatedContacts,
              }
            : undefined,
        });

        return { success: true, data: connections, count: connections.length };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[Social IPC] LinkedIn API scrape failed:", message);

        mainWindow?.webContents.send("social:linkedin:scrapeProgress", {
          status: "error",
          error: message,
        });

        return { success: false, error: message };
      }
    }
  );

  // ============================================================================
  // LinkedIn messaging handlers
  // ============================================================================

  /**
   * Get LinkedIn messaging sync status.
   * Returns connection status and current sync progress.
   */
  ipcMain.handle(
    "social:linkedin:messagingStatus",
    async (): Promise<LinkedInMessagingStatusResult> => {
      try {
        const syncManager = getLinkedInSyncManager();
        const progress = syncManager.getProgress();
        const hasClient = syncManager.client !== null;

        return {
          connected: hasClient && progress.status !== "error",
          syncProgress: progress,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[Social IPC] LinkedIn messaging status check failed:", message);
        return { connected: false, error: message };
      }
    }
  );

  /**
   * Start LinkedIn messaging sync.
   * Requires user to be logged in first (call social:linkedin:login).
   * Sets up the sync manager with the LinkedIn API client from the scraper.
   */
  ipcMain.handle(
    "social:linkedin:startMessagingSync",
    async (): Promise<LinkedInSyncResult> => {
      try {
        const scraper = getLinkedInScraper();

        // Get API client from scraper (will launch browser if needed)
        const apiClient = await scraper.getApiClient();

        // Configure sync manager (uses centralized auth from auth-manager)
        const syncManager = getLinkedInSyncManager();
        syncManager.setClient(apiClient);

        // Set up progress callback to notify renderer
        syncManager.setProgressCallback((progress) => {
          mainWindow?.webContents.send("social:linkedin:messagingSyncProgress", progress);
        });

        // Start background sync
        syncManager.start();

        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[Social IPC] LinkedIn messaging sync start failed:", message);
        return { success: false, error: message };
      }
    }
  );

  /**
   * Stop LinkedIn messaging sync.
   */
  ipcMain.handle(
    "social:linkedin:stopMessagingSync",
    async (): Promise<LinkedInSyncResult> => {
      try {
        const syncManager = getLinkedInSyncManager();
        syncManager.stop();
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[Social IPC] LinkedIn messaging sync stop failed:", message);
        return { success: false, error: message };
      }
    }
  );

  /**
   * Send a message via LinkedIn using the platform adapter.
   * For queued sends with undo support, use the messageQueue API instead.
   */
  ipcMain.handle(
    "social:linkedin:sendMessage",
    async (
      _event,
      conversationId: string,
      text: string
    ): Promise<LinkedInSendMessageResult> => {
      try {
        const adapter = getAdapter("linkedin");

        if (!adapter) {
          return {
            success: false,
            error: "LinkedIn adapter not available",
          };
        }

        const result = await adapter.send({
          id: `ipc-${Date.now()}`, // Temporary ID for IPC-based sends
          platform: "linkedin",
          recipientHandle: conversationId, // Not used by LinkedIn adapter
          text,
          threadId: conversationId, // LinkedIn adapter uses threadId for conversation URN
        });

        if (result.success) {
          return { success: true, messageId: result.messageId };
        } else {
          console.error("[Social IPC] LinkedIn send message failed:", result.error);
          return { success: false, error: result.error };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("[Social IPC] LinkedIn send message failed:", errorMessage);
        return { success: false, error: errorMessage };
      }
    }
  );

  /**
   * Get current LinkedIn messaging sync progress.
   */
  ipcMain.handle(
    "social:linkedin:getSyncProgress",
    async (): Promise<LinkedInSyncProgress> => {
      const syncManager = getLinkedInSyncManager();
      return syncManager.getProgress();
    }
  );

  // ============================================================================
  // Slack handlers (Native integration - Task 5.1)
  // ============================================================================

  /**
   * Check Slack connection status - returns all connected workspaces.
   */
  ipcMain.handle("social:slack:status", async (): Promise<SlackStatusResult> => {
    try {
      const allCredentials = getAllSlackCredentials();
      if (allCredentials.length === 0) {
        return { isConnected: false, workspaces: [] };
      }

      // Build workspace info for all connected workspaces
      const workspaces: SlackWorkspaceInfo[] = allCredentials.map((creds) => {
        const manager = getSlackSyncManager({ teamId: creds.teamId });
        return {
          teamId: creds.teamId,
          teamName: creds.teamName,
          userId: creds.userId,
          isConnected: true,
          syncProgress: manager.getProgress(),
        };
      });

      return {
        isConnected: workspaces.length > 0,
        teamName: workspaces[0]?.teamName, // Legacy field for backward compatibility
        workspaces,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Social IPC] Slack status check failed:", message);
      return { isConnected: false, workspaces: [], error: message };
    }
  });

  /**
   * Open Slack login in Electron BrowserWindow.
   * Extracts xoxc- token from localStorage and d cookie from session.
   * Supports adding multiple workspaces.
   */
  ipcMain.handle("social:slack:login", async (): Promise<SlackLoginResult> => {
    try {
      const result = await openSlackLogin();

      if (!result.success || !result.credentials) {
        return {
          success: false,
          error: result.error ?? "Login failed",
        };
      }

      // Store credentials in sync manager (creates new manager for this team)
      const syncManager = getSlackSyncManager({ teamId: result.credentials.teamId });
      syncManager.setCredentials({
        token: result.credentials.token,
        cookie: result.credentials.cookie,
        teamId: result.credentials.teamId,
        teamName: result.credentials.teamName,
        userId: result.credentials.userId,
      });

      return {
        success: true,
        teamId: result.credentials.teamId,
        teamName: result.credentials.teamName,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Social IPC] Slack login failed:", message);
      return { success: false, error: message };
    }
  });

  /**
   * Disconnect Slack - clears credentials and stops sync.
   * If teamId is provided, disconnects only that workspace.
   * If teamId is not provided, disconnects all workspaces.
   */
  ipcMain.handle(
    "social:slack:disconnect",
    async (_event, teamId?: string): Promise<SlackSyncResult> => {
      try {
        if (teamId) {
          const manager = getSlackSyncManager({ teamId });
          await manager.disconnect();
          removeSlackSyncManager(teamId);
        } else {
          const managers = getAllSlackSyncManagers();
          for (const manager of managers) {
            await manager.disconnect();
          }
          // Clear session cookies from Electron
          await clearSlackSession();
        }

        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[Social IPC] Slack disconnect failed:", message);
        return { success: false, error: message };
      }
    }
  );

  /**
   * List all connected Slack workspaces.
   */
  ipcMain.handle(
    "social:slack:listWorkspaces",
    async (): Promise<{ workspaces: SlackWorkspaceInfo[] }> => {
      try {
        const allCredentials = getAllSlackCredentials();
        const workspaces: SlackWorkspaceInfo[] = allCredentials.map((creds) => {
          const manager = getSlackSyncManager({ teamId: creds.teamId });
          return {
            teamId: creds.teamId,
            teamName: creds.teamName,
            userId: creds.userId,
            isConnected: true,
            syncProgress: manager.getProgress(),
          };
        });
        return { workspaces };
      } catch (error) {
        console.error("[Social IPC] List workspaces failed:", error);
        return { workspaces: [] };
      }
    }
  );

  /**
   * Get Slack messaging sync status for all workspaces.
   */
  ipcMain.handle(
    "social:slack:messagingStatus",
    async (): Promise<SlackSyncStatusResult> => {
      try {
        const allCredentials = getAllSlackCredentials();
        const workspaces: SlackWorkspaceInfo[] = allCredentials.map((creds) => {
          const manager = getSlackSyncManager({ teamId: creds.teamId });
          const progress = manager.getProgress();
          return {
            teamId: creds.teamId,
            teamName: creds.teamName,
            userId: creds.userId,
            isConnected: manager.hasCredentials() && progress.status !== "error",
            syncProgress: progress,
          };
        });

        const anyConnected = workspaces.some((w) => w.isConnected);
        return {
          connected: anyConnected,
          syncProgress: workspaces[0]?.syncProgress, // Legacy field
          workspaces,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[Social IPC] Slack messaging status check failed:", message);
        return { connected: false, workspaces: [], error: message };
      }
    }
  );

  /**
   * Start Slack messaging sync for all workspaces (or a specific one).
   * @param teamId - Optional team ID to start sync for only that workspace
   */
  ipcMain.handle(
    "social:slack:startMessagingSync",
    async (_event, teamId?: string): Promise<SlackSyncResult> => {
      try {
        const setupAndStartManager = async (manager: ReturnType<typeof getSlackSyncManager>) => {
          // Set up progress callback with team ID in the event (uses centralized auth from auth-manager)
          manager.setProgressCallback((progress) => {
            mainWindow?.webContents.send("social:slack:messagingSyncProgress", {
              ...progress,
              teamId: manager.getTeamId(),
            });
          });

          await manager.start();
        };

        if (teamId) {
          const manager = getSlackSyncManager({ teamId });
          await setupAndStartManager(manager);
        } else {
          const allCredentials = getAllSlackCredentials();
          for (const creds of allCredentials) {
            const manager = getSlackSyncManager({ teamId: creds.teamId });
            await setupAndStartManager(manager);
          }
        }

        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[Social IPC] Slack messaging sync start failed:", message);
        return { success: false, error: message };
      }
    }
  );

  /**
   * Stop Slack messaging sync for all workspaces (or a specific one).
   * @param teamId - Optional team ID to stop sync for only that workspace
   */
  ipcMain.handle(
    "social:slack:stopMessagingSync",
    async (_event, teamId?: string): Promise<SlackSyncResult> => {
      try {
        if (teamId) {
          const manager = getSlackSyncManager({ teamId });
          manager.stop();
        } else {
          const managers = getAllSlackSyncManagers();
          for (const manager of managers) {
            manager.stop();
          }
        }
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[Social IPC] Slack messaging sync stop failed:", message);
        return { success: false, error: message };
      }
    }
  );

  /**
   * Get current Slack messaging sync progress.
   */
  ipcMain.handle(
    "social:slack:getSyncProgress",
    async (): Promise<SlackSyncProgress> => {
      const syncManager = getSlackSyncManager();
      return syncManager.getProgress();
    }
  );

  // Slack progress listeners
  // Note: The renderer subscribes via onSlackMessagingSyncProgress
}

/**
 * Clean up scraper instances and sync managers on app quit.
 */
export async function cleanupSocialScrapers(): Promise<void> {
  try {
    // Stop LinkedIn sync manager
    const linkedInSyncManager = getLinkedInSyncManager();
    linkedInSyncManager.stop();

    // Stop all Slack sync managers
    const slackManagers = getAllSlackSyncManagers();
    for (const manager of slackManagers) {
      manager.stop();
    }

    linkedInScraper = null;
  } catch (error) {
    console.error("[Social IPC] Error cleaning up scrapers:", error);
  }
}
