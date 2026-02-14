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
} from "../platforms/linkedin/index.js";
import {
  TwitterScraper,
  getTwitterSyncManager,
  type TwitterSyncProgress,
} from "../platforms/twitter/index.js";
import {
  getSlackSyncManager,
  getAllSlackSyncManagers,
  removeSlackSyncManager,
  openSlackLogin,
  clearSlackSession,
  getAllSlackCredentials,
  type SlackSyncProgress,
} from "../platforms/slack/index.js";
import {
  checkSignalLoginStatus,
  setupSignalCli,
  startLinkInTerminal,
  checkLinkResult,
  clearSignalCredentials,
  getSignalSyncManager,
  type SignalSyncProgress,
} from "../platforms/signal/index.js";
import type {
  SignalLoginCredentials,
  SignalLoginResult,
  SignalSetupResult,
  SignalSendMessageResult,
  SignalStatusResult,
} from "../../shared/electron-api";
import { getAdapter } from "../adapters/index.js";
import { getSyncEngine } from "../sync/engine.js";
import { getErrorMessage } from "../sync/error-utils.js";
import { type SyncProgress } from "../sync/types.js";

// Singleton scraper instance to maintain state across calls
let linkedInScraper: LinkedInScraper | null = null;
let twitterScraper: TwitterScraper | null = null;

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

/**
 * Get the singleton TwitterScraper instance.
 * Ensures browser operations are serialized across all callers.
 */
export function getTwitterScraper(): TwitterScraper {
  if (!twitterScraper) {
    twitterScraper = new TwitterScraper();
  }
  return twitterScraper;
}

// ============================================================================
// Types
// ============================================================================

export interface SocialStatusResult {
  isLoggedIn: boolean;
  error?: string;
}

export interface SendMessageResult {
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
  setupTwitterHandlers(mainWindow);
  setupSlackHandlers(mainWindow);
  setupSignalHandlers(mainWindow);
}

// ============================================================================
// Unified Sync Handlers
// ============================================================================

function setupUnifiedSyncHandlers(_mainWindow: BrowserWindow | null): void {
  const engine = getSyncEngine();

  // Note: Progress callback is set in index.ts startBackgroundSync() which handles
  // both tray/power management and renderer notification. Don't set it here to avoid
  // overwriting that callback.

  // Shared handler for triggering sync
  function triggerSync(): RunAllSyncsResult {
    const triggered = engine.syncNow();
    if (!triggered) {
      return { success: false, skipped: true, error: "Sync engine is not running", platforms: {} };
    }
    return { success: true, platforms: engine.getProgress().platforms };
  }

  // Run all platform syncs
  ipcMain.handle("sync:runAll", async (): Promise<RunAllSyncsResult> => {
    try {
      return triggerSync();
    } catch (error) {
      return { success: false, error: getErrorMessage(error), platforms: {} };
    }
  });

  // Trigger immediate sync (uses stored options from interval)
  ipcMain.handle("sync:runNow", async (): Promise<RunAllSyncsResult> => {
    try {
      return triggerSync();
    } catch (error) {
      return { success: false, error: getErrorMessage(error), platforms: {} };
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

function setupLinkedInHandlers(_mainWindow: BrowserWindow | null): void {
  // Status check
  ipcMain.handle("sync:linkedin:status", async (): Promise<SocialStatusResult> => {
    try {
      const isLoggedIn = await getLinkedInScraper().checkLoginStatus();
      return { isLoggedIn };
    } catch (error) {
      const message = getErrorMessage(error);
      console.error("[Sync IPC] LinkedIn status check failed:", message);
      return { isLoggedIn: false, error: message };
    }
  });

  // Login
  ipcMain.handle("sync:linkedin:login", async (): Promise<SocialStatusResult> => {
    try {
      const scraper = getLinkedInScraper();
      const success = await scraper.loginLinkedIn();

      if (success) {
        try {
          const apiClient = await scraper.getApiClient();
          getLinkedInSyncManager().setClient(apiClient);
        } catch (e) {
          const setupError = getErrorMessage(e);
          console.error("[Sync IPC] LinkedIn login succeeded but sync setup failed:", e);
          return { isLoggedIn: false, error: `Login succeeded but sync setup failed: ${setupError}` };
        }
      }

      return { isLoggedIn: success };
    } catch (error) {
      const message = getErrorMessage(error);
      console.error("[Sync IPC] LinkedIn login failed:", message);
      return { isLoggedIn: false, error: message };
    }
  });

  // Logout
  ipcMain.handle("sync:linkedin:logout", async (): Promise<{ success: boolean; error?: string }> => {
    try {
      await getLinkedInScraper().logout();
      getLinkedInSyncManager().setClient(null);
      return { success: true };
    } catch (error) {
      const message = getErrorMessage(error);
      console.error("[Sync IPC] LinkedIn logout failed:", message);
      return { success: false, error: message };
    }
  });

  // Send message (needed for messaging functionality)
  ipcMain.handle(
    "sync:linkedin:sendMessage",
    async (_event, conversationId: string, text: string): Promise<SendMessageResult> => {
      try {
        const adapter = getAdapter("linkedin");
        if (!adapter) {
          return { success: false, error: "LinkedIn adapter not available" };
        }

        const result = await adapter.send({
          id: `ipc-${Date.now()}`,
          platform: "linkedin",
          recipientHandle: conversationId,
          text,
          threadId: conversationId,
        });

        if (!result.success) {
          console.error("[Sync IPC] LinkedIn send message failed:", result.error);
          return { success: false, error: result.error };
        }

        return { success: true, messageId: result.messageId };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
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
// Twitter Handlers (Login/Status/SendMessage only)
// ============================================================================

function setupTwitterHandlers(_mainWindow: BrowserWindow | null): void {
  // Status check
  ipcMain.handle("sync:twitter:status", async (): Promise<SocialStatusResult> => {
    try {
      const isLoggedIn = await getTwitterScraper().checkLoginStatus();
      return { isLoggedIn };
    } catch (error) {
      const message = getErrorMessage(error);
      console.error("[Sync IPC] Twitter status check failed:", message);
      return { isLoggedIn: false, error: message };
    }
  });

  // Login
  ipcMain.handle("sync:twitter:login", async (): Promise<SocialStatusResult> => {
    try {
      const scraper = getTwitterScraper();
      const success = await scraper.loginTwitter();

      if (success) {
        try {
          const apiClient = await scraper.getApiClient();
          getTwitterSyncManager().setClient(apiClient);
        } catch (e) {
          const setupError = getErrorMessage(e);
          console.error("[Sync IPC] Twitter login succeeded but sync setup failed:", e);
          return { isLoggedIn: false, error: `Login succeeded but sync setup failed: ${setupError}` };
        }
      }

      return { isLoggedIn: success };
    } catch (error) {
      const message = getErrorMessage(error);
      console.error("[Sync IPC] Twitter login failed:", message);
      return { isLoggedIn: false, error: message };
    }
  });

  // Logout
  ipcMain.handle("sync:twitter:logout", async (): Promise<{ success: boolean; error?: string }> => {
    try {
      await getTwitterScraper().logout();
      getTwitterSyncManager().setClient(null);
      return { success: true };
    } catch (error) {
      const message = getErrorMessage(error);
      console.error("[Sync IPC] Twitter logout failed:", message);
      return { success: false, error: message };
    }
  });

  // Send message
  ipcMain.handle(
    "sync:twitter:sendMessage",
    async (_event, conversationId: string, text: string): Promise<SendMessageResult> => {
      try {
        const adapter = getAdapter("twitter");
        if (!adapter) {
          return { success: false, error: "Twitter adapter not available" };
        }

        const result = await adapter.send({
          id: `ipc-${Date.now()}`,
          platform: "twitter",
          recipientHandle: conversationId,
          text,
          threadId: conversationId,
        });

        if (!result.success) {
          console.error("[Sync IPC] Twitter send message failed:", result.error);
          return { success: false, error: result.error };
        }

        return { success: true, messageId: result.messageId };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error("[Sync IPC] Twitter send message failed:", errorMessage);
        return { success: false, error: errorMessage };
      }
    }
  );

  // Get sync progress (for status display)
  ipcMain.handle("sync:twitter:getProgress", async (): Promise<TwitterSyncProgress> => {
    const syncManager = getTwitterSyncManager();
    return syncManager.getProgress();
  });

  // Sync contacts (followers/following mutuals)
  ipcMain.handle("sync:twitter:syncContacts", async (): Promise<{ contactsSynced: number; skipped: boolean; error?: string }> => {
    try {
      const scraper = getTwitterScraper();
      const syncManager = getTwitterSyncManager();
      return await syncManager.syncContacts(scraper);
    } catch (error) {
      const message = getErrorMessage(error);
      console.error("[Sync IPC] Twitter contacts sync failed:", message);
      return { contactsSynced: 0, skipped: false, error: message };
    }
  });
}

// ============================================================================
// Slack Handlers (Login/Status/Disconnect only)
// ============================================================================

function setupSlackHandlers(_mainWindow: BrowserWindow | null): void {
  // Helper to build workspace info list
  function buildWorkspaceInfoList(): SlackWorkspaceInfo[] {
    return getAllSlackCredentials().map((creds) => ({
      teamId: creds.teamId,
      teamName: creds.teamName,
      userId: creds.userId,
      isConnected: true,
      syncProgress: getSlackSyncManager({ teamId: creds.teamId }).getProgress(),
    }));
  }

  // Status check
  ipcMain.handle("sync:slack:status", async (): Promise<SlackStatusResult> => {
    try {
      const workspaces = buildWorkspaceInfoList();
      return {
        isConnected: workspaces.length > 0,
        teamName: workspaces[0]?.teamName,
        workspaces,
      };
    } catch (error) {
      const message = getErrorMessage(error);
      console.error("[Sync IPC] Slack status check failed:", message);
      return { isConnected: false, workspaces: [], error: message };
    }
  });

  // Login
  ipcMain.handle("sync:slack:login", async (): Promise<SlackLoginResult> => {
    try {
      const result = await openSlackLogin();
      if (!result.success || !result.credentials) {
        return { success: false, error: result.error ?? "Login failed" };
      }

      const { credentials } = result;
      const syncManager = getSlackSyncManager({ teamId: credentials.teamId });
      syncManager.setCredentials({
        token: credentials.token,
        cookie: credentials.cookie,
        teamId: credentials.teamId,
        teamName: credentials.teamName,
        userId: credentials.userId,
      });

      // Register the new Slack workspace with the sync engine
      const { createSlackSyncFn } = await import("../sync/sync-functions.js");
      const { getValidAccessToken } = await import("../auth/index.js");

      getSyncEngine().registerSync(
        "slack",
        createSlackSyncFn({ getAuthToken: getValidAccessToken }, credentials.teamId),
        credentials.teamId
      );

      return { success: true, teamId: credentials.teamId, teamName: credentials.teamName };
    } catch (error) {
      const message = getErrorMessage(error);
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
          await getSlackSyncManager({ teamId }).disconnect();
          removeSlackSyncManager(teamId);
          engine.unregisterSync("slack", teamId);
        } else {
          for (const manager of getAllSlackSyncManagers()) {
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
        const message = getErrorMessage(error);
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
        return { workspaces: buildWorkspaceInfoList() };
      } catch (error) {
        const message = getErrorMessage(error);
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
// Signal Handlers (Setup/Link/Status/SendMessage only)
// ============================================================================

function setupSignalHandlers(_mainWindow: BrowserWindow | null): void {
  // Status check
  ipcMain.handle("sync:signal:status", async (): Promise<SignalStatusResult> => {
    try {
      const result = await checkSignalLoginStatus();
      return { isLoggedIn: result.isLoggedIn, error: result.error };
    } catch (error) {
      const message = getErrorMessage(error);
      console.error("[Sync IPC] Signal status check failed:", message);
      return { isLoggedIn: false, error: message };
    }
  });

  // Setup (Java check + signal-cli download)
  ipcMain.handle(
    "sync:signal:setup",
    async (_event, credentials?: SignalLoginCredentials): Promise<SignalSetupResult> => {
      try {
        return await setupSignalCli(credentials);
      } catch (error) {
        const message = getErrorMessage(error);
        console.error("[Sync IPC] Signal setup failed:", message);
        return { success: false, steps: [], error: message };
      }
    }
  );

  // Open Terminal.app for linking
  ipcMain.handle(
    "sync:signal:openLinkTerminal",
    async (_event, cliPath: string): Promise<{ success: boolean; error?: string }> => {
      try {
        return await startLinkInTerminal(cliPath);
      } catch (error) {
        const message = getErrorMessage(error);
        console.error("[Sync IPC] Signal open link terminal failed:", message);
        return { success: false, error: message };
      }
    }
  );

  // Check if linking completed
  ipcMain.handle(
    "sync:signal:checkLink",
    async (_event, cliPath: string): Promise<SignalLoginResult> => {
      try {
        const result = await checkLinkResult(cliPath);

        // Register sync functions with the engine after successful link
        if (result.success && result.isLoggedIn) {
          const { createSignalSyncFn, createSignalContactsSyncFn } = await import("../sync/sync-functions.js");
          const { getValidAccessToken } = await import("../auth/index.js");
          const syncOptions = { getAuthToken: getValidAccessToken };

          getSyncEngine().registerSync("signal_contacts", createSignalContactsSyncFn(syncOptions));
          getSyncEngine().registerSync("signal", createSignalSyncFn(syncOptions));
        }

        return result;
      } catch (error) {
        const message = getErrorMessage(error);
        console.error("[Sync IPC] Signal check link failed:", message);
        return { success: false, isLoggedIn: false, error: message };
      }
    }
  );

  // Logout
  ipcMain.handle("sync:signal:logout", async (): Promise<{ success: boolean; error?: string }> => {
    try {
      getSyncEngine().unregisterSync("signal");
      getSyncEngine().unregisterSync("signal_contacts");
      const manager = getSignalSyncManager();
      await manager.disconnect();
      clearSignalCredentials();
      return { success: true };
    } catch (error) {
      const message = getErrorMessage(error);
      console.error("[Sync IPC] Signal logout failed:", message);
      return { success: false, error: message };
    }
  });

  // Send message
  ipcMain.handle(
    "sync:signal:sendMessage",
    async (_event, threadOrRecipient: string, text: string): Promise<SignalSendMessageResult> => {
      try {
        const adapter = getAdapter("signal");
        if (!adapter) {
          return { success: false, error: "Signal adapter not available" };
        }

        const result = await adapter.send({
          id: `ipc-${Date.now()}`,
          platform: "signal",
          recipientHandle: threadOrRecipient,
          text,
          threadId: threadOrRecipient,
        });

        if (!result.success) {
          return { success: false, error: result.error };
        }

        return { success: true, messageId: result.messageId };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error("[Sync IPC] Signal send message failed:", errorMessage);
        return { success: false, error: errorMessage };
      }
    }
  );

  // Get sync progress
  ipcMain.handle("sync:signal:getProgress", async (): Promise<SignalSyncProgress> => {
    const manager = getSignalSyncManager();
    return manager.getProgress();
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

    // Stop Twitter sync manager
    const twitterSyncManager = getTwitterSyncManager();
    twitterSyncManager.stop();

    // Stop all Slack sync managers
    const slackManagers = getAllSlackSyncManagers();
    for (const manager of slackManagers) {
      manager.stop();
    }

    // Stop Signal sync manager
    const signalManager = getSignalSyncManager();
    signalManager.stop();

    linkedInScraper = null;
    twitterScraper = null;
  } catch (error) {
    console.error("[Sync IPC] Error cleaning up sync managers:", error);
  }
}
