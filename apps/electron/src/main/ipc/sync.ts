/**
 * Unified IPC handlers for all platform sync operations.
 * Consolidates iMessage, LinkedIn, and Slack sync under the sync: namespace.
 */

import { ipcMain, BrowserWindow } from "electron";
import { getIMessageSyncManager } from "../platforms/imessage";
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
  openSlackLogin,
  clearSlackSession,
  getAllSlackCredentials,
  type SlackSyncProgress,
} from "../platforms/slack";
import { getAdapter } from "../adapters";
import { getValidAccessToken } from "../auth";
import { electronEnv } from "@prm/env/electron";
import { runAllSyncs, type RunAllSyncsResult } from "../sync/run-all";

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

// ============================================================================
// Types
// ============================================================================

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

// ============================================================================
// Helper Functions
// ============================================================================

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
    const token = await getValidAccessToken(retryCount > 0);
    if (!token) {
      return { success: false, error: "No auth token available" };
    }

    const baseUrl = electronEnv.API_BASE_URL || "http://localhost:3000";

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

    if (response.status === 401 && retryCount < MAX_RETRIES) {
      return syncLinkedInContactsToBackend(connections, retryCount + 1);
    }

    if (!response.ok) {
      const text = await response.text();
      if (text.includes("<!DOCTYPE") && retryCount < MAX_RETRIES) {
        return syncLinkedInContactsToBackend(connections, retryCount + 1);
      }
      return {
        success: false,
        error: `API error: ${response.status} - ${text.slice(0, 100)}`,
      };
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      const htmlBody = await response.text();
      if (htmlBody.includes("404") || htmlBody.includes("Not Found")) {
        return { success: false, error: "API route not found (404)" };
      }
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
    console.error("[Sync IPC] LinkedIn sync to backend failed:", message);
    return { success: false, error: message };
  }
}

// ============================================================================
// Main Setup Function
// ============================================================================

/**
 * Set up all sync IPC handlers for iMessage, LinkedIn, and Slack.
 * Call this once during app initialization in main/index.ts.
 */
export function setupAllSyncIpcHandlers(mainWindow: BrowserWindow | null): void {
  setupIMessageHandlers(mainWindow);
  setupLinkedInHandlers(mainWindow);
  setupSlackHandlers(mainWindow);
  setupUnifiedSyncHandler(mainWindow);
}

// ============================================================================
// Unified Sync Handler
// ============================================================================

function setupUnifiedSyncHandler(_mainWindow: BrowserWindow | null): void {
  // Run all platform syncs sequentially
  ipcMain.handle("sync:runAll", async (): Promise<RunAllSyncsResult> => {
    return runAllSyncs({
      getAuthToken: getValidAccessToken,
      linkedInScraper: getLinkedInScraper(),
    });
  });
}

// ============================================================================
// iMessage Handlers
// ============================================================================

function setupIMessageHandlers(_mainWindow: BrowserWindow | null): void {
  // Note: The sync manager is configured in startBackgroundSync() with onProgress and syncContacts callbacks.
  // These handlers just expose the manager's methods via IPC.

  ipcMain.handle("sync:imessage:getProgress", () => getIMessageSyncManager().getProgress());

  ipcMain.handle("sync:imessage:runNow", async () => {
    const manager = getIMessageSyncManager();
    await manager.runSync();
    return manager.getProgress();
  });

  ipcMain.handle("sync:imessage:reset", () => {
    const manager = getIMessageSyncManager();
    manager.resetCursor();
    return manager.getProgress();
  });

  ipcMain.handle("sync:imessage:forceFullSync", async () => {
    const manager = getIMessageSyncManager();
    await manager.forceFullSync();
    return manager.getProgress();
  });
}

// ============================================================================
// LinkedIn Handlers
// ============================================================================

function setupLinkedInHandlers(mainWindow: BrowserWindow | null): void {
  // Status check
  ipcMain.handle("sync:linkedin:status", async (): Promise<SocialStatusResult> => {
    try {
      const scraper = getLinkedInScraper();
      const isLoggedIn = await scraper.checkLoginStatus();
      return { isLoggedIn };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Sync IPC] LinkedIn status check failed:", message);
      return { isLoggedIn: false, error: message };
    }
  });

  // Login
  ipcMain.handle("sync:linkedin:login", async (): Promise<SocialStatusResult> => {
    try {
      const scraper = getLinkedInScraper();
      const success = await scraper.loginLinkedIn();
      return { isLoggedIn: success };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Sync IPC] LinkedIn login failed:", message);
      return { isLoggedIn: false, error: message };
    }
  });

  // Scrape connections
  ipcMain.handle(
    "sync:linkedin:scrape",
    async (
      _event,
      options?: { maxConnections?: number }
    ): Promise<SocialScrapeResult<LinkedInConnection>> => {
      try {
        const scraper = getLinkedInScraper();

        mainWindow?.webContents.send("sync:linkedin:scrapeProgress", {
          status: "starting",
          count: 0,
        });

        const apiConnections = await scraper.scrapeConnectionsViaApi({
          maxConnections: options?.maxConnections,
        });

        const connections: LinkedInConnection[] = apiConnections.map((conn) => ({
          name: `${conn.firstName} ${conn.lastName}`.trim(),
          profileUrl: conn.profileUrl,
          headline: conn.headline ?? null,
          connectedDate: conn.connectionDate ?? null,
          profileId: conn.profileId,
        }));

        mainWindow?.webContents.send("sync:linkedin:scrapeProgress", {
          status: "syncing",
          count: connections.length,
        });

        const syncResult = await syncLinkedInContactsToBackend(connections);
        if (!syncResult.success) {
          console.warn(`[Sync IPC] LinkedIn backend sync failed: ${syncResult.error}`);
        }

        mainWindow?.webContents.send("sync:linkedin:scrapeProgress", {
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
        console.error("[Sync IPC] LinkedIn API scrape failed:", message);

        mainWindow?.webContents.send("sync:linkedin:scrapeProgress", {
          status: "error",
          error: message,
        });

        return { success: false, error: message };
      }
    }
  );

  // Messaging status
  ipcMain.handle(
    "sync:linkedin:messagingStatus",
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
        console.error("[Sync IPC] LinkedIn messaging status check failed:", message);
        return { connected: false, error: message };
      }
    }
  );

  // Start messaging sync
  ipcMain.handle("sync:linkedin:start", async (): Promise<LinkedInSyncResult> => {
    try {
      const scraper = getLinkedInScraper();
      const apiClient = await scraper.getApiClient();

      const syncManager = getLinkedInSyncManager();
      syncManager.setClient(apiClient);

      syncManager.setProgressCallback((progress) => {
        mainWindow?.webContents.send("sync:linkedin:progress", progress);
      });

      syncManager.start();

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Sync IPC] LinkedIn messaging sync start failed:", message);
      return { success: false, error: message };
    }
  });

  // Stop messaging sync
  ipcMain.handle("sync:linkedin:stop", async (): Promise<LinkedInSyncResult> => {
    try {
      const syncManager = getLinkedInSyncManager();
      syncManager.stop();
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Sync IPC] LinkedIn messaging sync stop failed:", message);
      return { success: false, error: message };
    }
  });

  // Send message
  ipcMain.handle(
    "sync:linkedin:sendMessage",
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
          id: `ipc-${Date.now()}`,
          platform: "linkedin",
          recipientHandle: conversationId,
          text,
          threadId: conversationId,
        });

        if (result.success) {
          return { success: true, messageId: result.messageId };
        } else {
          console.error("[Sync IPC] LinkedIn send message failed:", result.error);
          return { success: false, error: result.error };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("[Sync IPC] LinkedIn send message failed:", errorMessage);
        return { success: false, error: errorMessage };
      }
    }
  );

  // Get sync progress
  ipcMain.handle("sync:linkedin:getProgress", async (): Promise<LinkedInSyncProgress> => {
    const syncManager = getLinkedInSyncManager();
    return syncManager.getProgress();
  });
}

// ============================================================================
// Slack Handlers
// ============================================================================

function setupSlackHandlers(mainWindow: BrowserWindow | null): void {
  // Status check
  ipcMain.handle("sync:slack:status", async (): Promise<SlackStatusResult> => {
    try {
      const allCredentials = getAllSlackCredentials();
      if (allCredentials.length === 0) {
        return { isConnected: false, workspaces: [] };
      }

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
        teamName: workspaces[0]?.teamName,
        workspaces,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Sync IPC] Slack status check failed:", message);
      return { isConnected: false, workspaces: [], error: message };
    }
  });

  // Login
  ipcMain.handle("sync:slack:login", async (): Promise<SlackLoginResult> => {
    try {
      const result = await openSlackLogin();

      if (!result.success || !result.credentials) {
        return {
          success: false,
          error: result.error ?? "Login failed",
        };
      }

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
      console.error("[Sync IPC] Slack login failed:", message);
      return { success: false, error: message };
    }
  });

  // Disconnect
  ipcMain.handle(
    "sync:slack:disconnect",
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
          await clearSlackSession();
        }

        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[Sync IPC] Slack disconnect failed:", message);
        return { success: false, error: message };
      }
    }
  );

  // List workspaces
  ipcMain.handle(
    "sync:slack:listWorkspaces",
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
        console.error("[Sync IPC] List workspaces failed:", error);
        return { workspaces: [] };
      }
    }
  );

  // Messaging status
  ipcMain.handle(
    "sync:slack:messagingStatus",
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
          syncProgress: workspaces[0]?.syncProgress,
          workspaces,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[Sync IPC] Slack messaging status check failed:", message);
        return { connected: false, workspaces: [], error: message };
      }
    }
  );

  // Start messaging sync
  ipcMain.handle(
    "sync:slack:start",
    async (_event, teamId?: string): Promise<SlackSyncResult> => {
      try {
        const setupAndStartManager = async (manager: ReturnType<typeof getSlackSyncManager>) => {
          manager.setProgressCallback((progress) => {
            mainWindow?.webContents.send("sync:slack:progress", {
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
        console.error("[Sync IPC] Slack messaging sync start failed:", message);
        return { success: false, error: message };
      }
    }
  );

  // Stop messaging sync
  ipcMain.handle(
    "sync:slack:stop",
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
        console.error("[Sync IPC] Slack messaging sync stop failed:", message);
        return { success: false, error: message };
      }
    }
  );

  // Get sync progress
  ipcMain.handle("sync:slack:getProgress", async (): Promise<SlackSyncProgress> => {
    const syncManager = getSlackSyncManager();
    return syncManager.getProgress();
  });
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Clean up sync managers on app quit.
 */
export async function cleanupSyncManagers(): Promise<void> {
  try {
    // Stop iMessage sync
    getIMessageSyncManager().stop();

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
    console.error("[Sync IPC] Error cleaning up sync managers:", error);
  }
}
