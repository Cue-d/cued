/**
 * Unified IPC handlers for sync operations.
 *
 * All syncing goes through the XState-based SyncEngine.
 * Individual platform handlers are only for login/status/disconnect operations.
 */

import { ipcMain, BrowserWindow } from "electron";
import {
  LinkedInScraper,
  getLinkedInSyncManager,
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
import { getSyncEngine, type SyncEngineOptions } from "../sync/engine";
import { createAllSyncFunctions } from "../sync/sync-functions";
import { type SyncProgress } from "../sync/types";

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

export interface SocialStatusResult {
  isLoggedIn: boolean;
  error?: string;
}

export interface LinkedInSendMessageResult {
  success: boolean;
  messageId?: string;
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

export interface SlackDisconnectResult {
  success: boolean;
  error?: string;
}

// Result type for backwards compatibility
export interface RunAllSyncsResult {
  success: boolean;
  skipped?: boolean;
  error?: string;
  platforms: SyncProgress['platforms'];
}

// ============================================================================
// Main Setup Function
// ============================================================================

/**
 * Set up all sync IPC handlers.
 * Call this once during app initialization in main/index.ts.
 */
export function setupAllSyncIpcHandlers(mainWindow: BrowserWindow | null): void {
  setupUnifiedSyncHandlers(mainWindow);
  setupLinkedInHandlers(mainWindow);
  setupSlackHandlers(mainWindow);
}

// ============================================================================
// Unified Sync Handlers
// ============================================================================

function setupUnifiedSyncHandlers(mainWindow: BrowserWindow | null): void {
  const engine = getSyncEngine();

  // Note: Progress callback is set in index.ts startBackgroundSync() which handles
  // both tray/power management and renderer notification. Don't set it here to avoid
  // overwriting that callback.

  // Run all platform syncs
  ipcMain.handle("sync:runAll", async (): Promise<RunAllSyncsResult> => {
    try {
      engine.syncNow();
      const progress = engine.getProgress();
      return {
        success: true,
        platforms: progress.platforms,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: message,
        platforms: {},
      };
    }
  });

  // Trigger immediate sync (uses stored options from interval)
  ipcMain.handle("sync:runNow", async (): Promise<RunAllSyncsResult> => {
    try {
      engine.syncNow();
      const progress = engine.getProgress();
      return {
        success: true,
        platforms: progress.platforms,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: message,
        platforms: {},
      };
    }
  });

  // Get unified sync progress
  ipcMain.handle("sync:getProgress", (): SyncProgress => {
    return engine.getProgress();
  });
}

// ============================================================================
// LinkedIn Handlers (Login/Status/SendMessage only)
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

      // If login successful, set up the sync manager client
      if (success) {
        try {
          const apiClient = await scraper.getApiClient();
          const syncManager = getLinkedInSyncManager();
          syncManager.setClient(apiClient);
        } catch (e) {
          const setupError = e instanceof Error ? e.message : String(e);
          console.error("[Sync IPC] LinkedIn login succeeded but sync setup failed:", e);
          return {
            isLoggedIn: false,
            error: `Login succeeded but sync setup failed: ${setupError}`,
          };
        }
      }

      return { isLoggedIn: success };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Sync IPC] LinkedIn login failed:", message);
      return { isLoggedIn: false, error: message };
    }
  });

  // Logout
  ipcMain.handle("sync:linkedin:logout", async (): Promise<{ success: boolean; error?: string }> => {
    try {
      const scraper = getLinkedInScraper();
      await scraper.logout();

      // Clear sync manager client
      const syncManager = getLinkedInSyncManager();
      syncManager.setClient(null as unknown as Parameters<typeof syncManager.setClient>[0]);

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Sync IPC] LinkedIn logout failed:", message);
      return { success: false, error: message };
    }
  });

  // Send message (needed for messaging functionality)
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

  // Get sync progress (for status display)
  ipcMain.handle("sync:linkedin:getProgress", async (): Promise<LinkedInSyncProgress> => {
    const syncManager = getLinkedInSyncManager();
    return syncManager.getProgress();
  });
}

// ============================================================================
// Slack Handlers (Login/Status/Disconnect only)
// ============================================================================

function setupSlackHandlers(_mainWindow: BrowserWindow | null): void {
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

      // Set up sync manager with credentials
      const syncManager = getSlackSyncManager({ teamId: result.credentials.teamId });
      syncManager.setCredentials({
        token: result.credentials.token,
        cookie: result.credentials.cookie,
        teamId: result.credentials.teamId,
        teamName: result.credentials.teamName,
        userId: result.credentials.userId,
      });

      // Register the new Slack workspace with the sync engine
      const engine = getSyncEngine();
      const { createSlackSyncFn } = await import("../sync/sync-functions");
      const { getValidAccessToken } = await import("../auth");

      engine.registerSync(
        "slack",
        createSlackSyncFn(
          { getAuthToken: getValidAccessToken },
          result.credentials.teamId
        ),
        result.credentials.teamId
      );

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
    async (_event, teamId?: string): Promise<SlackDisconnectResult> => {
      try {
        const engine = getSyncEngine();

        if (teamId) {
          const manager = getSlackSyncManager({ teamId });
          await manager.disconnect();
          removeSlackSyncManager(teamId);
          engine.unregisterSync("slack", teamId);
        } else {
          const managers = getAllSlackSyncManagers();
          for (const manager of managers) {
            const managerTeamId = manager.getTeamId();
            await manager.disconnect();
            if (managerTeamId) {
              engine.unregisterSync("slack", managerTeamId);
            }
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
    async (): Promise<{ workspaces: SlackWorkspaceInfo[]; error?: string }> => {
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
        const message = error instanceof Error ? error.message : String(error);
        console.error("[Sync IPC] List workspaces failed:", message);
        return { workspaces: [], error: message };
      }
    }
  );

  // Get sync progress (for status display)
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
    // Stop the sync engine
    const engine = getSyncEngine();
    engine.stop();

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
