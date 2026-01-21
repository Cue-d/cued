// Load env vars FIRST before any other imports
import "./env.js";

import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import liquidGlass from "electron-liquid-glass";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@prm/convex";
import { electronEnv } from "@prm/env/electron";
import {
  initAuth,
  getAuthState,
  getValidAccessToken,
  startDeviceAuth,
  signOut,
} from "./auth";
import { getSyncManager, type SyncProgress } from "./sync/sync-manager";
import { getContactsWatcher } from "./sync/contacts-watcher";
import { syncContactsToConvex } from "./sync/contacts-sync";
import { getHeartbeatManager } from "./sync/presence";
import { setupSocialIpcHandlers, cleanupSocialScrapers } from "./ipc/social";
import { getLinkedInSyncManager } from "./sync/linkedin-sync";
import { LinkedInScraper } from "./sync/linkedin";
import { getMessageQueueProcessor } from "./queue/message-queue-processor";
import { getReactiveConvexClient } from "./convex-client";
import { getSyncCoordinator } from "./sync/sync-coordinator";

const CONVEX_URL = electronEnv.CONVEX_URL;
const WORKOS_CLIENT_ID = electronEnv.WORKOS_CLIENT_ID;

let mainWindow: BrowserWindow | null = null;

/**
 * Check if running on macOS Tahoe (26+) which supports Liquid Glass
 */
function isTahoe(): boolean {
  if (process.platform !== "darwin") return false;
  const [major] = process.getSystemVersion().split(".").map(Number);
  return major >= 26;
}

function createWindow(): void {
  const useLiquidGlass = isTahoe();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    transparent: useLiquidGlass,
    titleBarStyle: useLiquidGlass ? "hiddenInset" : "default",
    backgroundColor: useLiquidGlass ? undefined : "#1a1a1a",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Apply Liquid Glass effect on macOS Tahoe+
  if (useLiquidGlass) {
    mainWindow.setWindowButtonVisibility(true);
  }

  // In development, load from dev server
  // In production, load from built files
  if (electronEnv.NODE_ENV === "development") {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function setupAuthIpcHandlers(): void {
  // Get current auth state
  ipcMain.handle("auth:getState", () => {
    return getAuthState();
  });

  // Start device authorization flow
  ipcMain.handle("auth:startLogin", async () => {
    await startDeviceAuth({
      onUserCode: (code, uri) => {
        // Notify renderer to display user code
        mainWindow?.webContents.send("auth:userCode", code, uri);
      },
      onAuthSuccess: async (user) => {
        // Notify renderer of auth state change
        mainWindow?.webContents.send("auth:stateChanged", {
          isAuthenticated: true,
          user,
        });

        // Sync user profile to Convex
        if (user) {
          try {
            const token = await getValidAccessToken();
            if (token) {
              const convex = new ConvexHttpClient(CONVEX_URL);
              convex.setAuth(token);
              await convex.mutation(api.users.syncProfile, {
                email: user.email,
                firstName: user.firstName ?? undefined,
                lastName: user.lastName ?? undefined,
              });
              console.log("[Main] User profile synced to Convex");
            }
          } catch (e) {
            console.warn("[Main] Failed to sync user profile:", e);
          }
        }

        // Start sync with token provider and auth invalid callback
        const syncManager = getSyncManager();
        syncManager.setTokenProvider(getValidAccessToken);
        syncManager.setAuthInvalidCallback(() => {
          console.log("[Main] Auth invalid during sync, notifying renderer");
          mainWindow?.webContents.send("auth:stateChanged", {
            isAuthenticated: false,
            user: null,
          });
        });
        syncManager.start();
      },
      onAuthError: (error) => {
        // Notify renderer of auth failure
        mainWindow?.webContents.send("auth:stateChanged", {
          isAuthenticated: false,
          user: null,
          error,
        });
      },
    });
  });

  // Sign out
  ipcMain.handle("auth:signOut", () => {
    signOut();
    getSyncManager().stop();
    mainWindow?.webContents.send("auth:stateChanged", {
      isAuthenticated: false,
      user: null,
    });
  });
}

function setupSyncIpcHandlers(): void {
  ipcMain.handle("sync:getProgress", () => getSyncManager().getProgress());

  ipcMain.handle("sync:runNow", async () => {
    const manager = getSyncManager();
    await manager.runSync();
    return manager.getProgress();
  });

  ipcMain.handle("sync:reset", () => {
    const manager = getSyncManager();
    manager.resetCursor();
    return manager.getProgress();
  });

  // Force full sync: resets both server and local state, then re-syncs messages + contacts
  ipcMain.handle("sync:forceFullSync", async () => {
    const manager = getSyncManager();
    await manager.forceFullSync();
    return manager.getProgress();
  });
}

async function startBackgroundSync(): Promise<void> {
  try {
    // Check if user is authenticated before starting sync
    const authState = getAuthState();
    if (!authState.isAuthenticated) {
      console.log("[Main] Not authenticated, skipping background sync");
      return;
    }

    // Initialize SyncCoordinator FIRST - this manages all sync operations
    const coordinator = getSyncCoordinator({
      getAuthToken: getValidAccessToken,
      onAuthInvalid: () => {
        console.log("[Main] Auth invalid from coordinator, notifying renderer");
        mainWindow?.webContents.send("auth:stateChanged", {
          isAuthenticated: false,
          user: null,
        });
      },
      tokenTtlSeconds: 3600, // WorkOS tokens last 1 hour
      refreshThreshold: 0.8, // Refresh at 80% (48 mins)
    });
    console.log("[Main] SyncCoordinator initialized");

    const syncManager = getSyncManager({
      getAuthToken: () => coordinator.getValidToken(), // Use coordinator's token
      onProgress: (progress: SyncProgress) => {
        // Notify renderer of sync progress
        mainWindow?.webContents.send("sync:progress", progress);
      },
      onAuthInvalid: () => {
        // Notify renderer that auth is no longer valid
        console.log("[Main] Auth invalid, notifying renderer");
        mainWindow?.webContents.send("auth:stateChanged", {
          isAuthenticated: false,
          user: null,
        });
      },
      // Wire contacts sync for recovery flows - goes through coordinator
      syncContacts: async () => {
        return coordinator.scheduleContactsSync(async () => {
          const result = await syncContactsToConvex(() => coordinator.getValidToken(), true);
          mainWindow?.webContents.send("contacts:synced", result);
        }).then(() => ({ contactsCount: 0 })); // SyncManager expects return value
      },
    });

    syncManager.start();
    console.log("[Main] Background sync started");

    // Start contacts watcher for incremental contact sync
    startContactsWatcher();

    // Configure and start the unified message queue processor
    // This replaces the old iMessage sender with a multi-platform queue
    const reactiveClient = getReactiveConvexClient();
    reactiveClient.setTokenProvider(getValidAccessToken);
    reactiveClient.setAuthInvalidCallback(() => {
      console.log("[Main] ReactiveConvexClient auth invalid, notifying renderer");
      mainWindow?.webContents.send("auth:stateChanged", {
        isAuthenticated: false,
        user: null,
      });
    });

    const queueProcessor = getMessageQueueProcessor();
    queueProcessor.start();
    console.log("[Main] Message queue processor started");

    // Start presence heartbeat for mobile to detect desktop online status
    const heartbeatManager = getHeartbeatManager(getValidAccessToken);
    heartbeatManager.start();
    console.log("[Main] Presence heartbeat started");

    // Auto-start LinkedIn messaging sync if already logged in
    startLinkedInMessagingSync();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Main] Failed to start background sync:", message);
    // Don't crash the app if sync fails to start
  }
}

/**
 * Auto-start LinkedIn messaging sync if user is already logged in.
 */
async function startLinkedInMessagingSync(): Promise<void> {
  try {
    const scraper = new LinkedInScraper();
    const isLoggedIn = await scraper.checkLoginStatus();

    if (!isLoggedIn) {
      console.log("[Main] LinkedIn not logged in, skipping auto-start");
      return;
    }

    console.log("[Main] LinkedIn logged in, starting messaging sync...");

    // Get API client from scraper
    const apiClient = await scraper.getApiClient();

    // Configure sync manager
    const syncManager = getLinkedInSyncManager();
    syncManager.setClient(apiClient);
    syncManager.setTokenProvider(getValidAccessToken);

    // Set up progress callback to notify renderer
    syncManager.setProgressCallback((progress) => {
      mainWindow?.webContents.send("social:linkedin:messagingSyncProgress", progress);
    });

    // Set up auth invalid callback
    syncManager.setAuthInvalidCallback(() => {
      console.log("[Main] LinkedIn auth invalid, stopping sync");
      mainWindow?.webContents.send("social:linkedin:authInvalid", {});
    });

    // Start sync (will use realtime by default)
    await syncManager.start();

    console.log("[Main] LinkedIn messaging sync auto-started");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.log("[Main] LinkedIn auto-start failed (non-fatal):", message);
    // Non-fatal - user can manually start later
  }
}

/**
 * Start watching for contacts changes and sync when detected.
 * Uses SyncCoordinator to serialize with iMessage sync.
 */
function startContactsWatcher(): void {
  const watcher = getContactsWatcher();
  const coordinator = getSyncCoordinator();

  watcher.on("change", async () => {
    console.log("[Main] Contacts changed, scheduling sync via coordinator...");
    try {
      // Schedule through coordinator to prevent race with iMessage sync
      await coordinator.scheduleContactsSync(async () => {
        const result = await syncContactsToConvex(() => coordinator.getValidToken(), true);
        console.log(
          `[Main] Contacts sync complete: ${result.contactsCount} contacts in ${Math.round(result.elapsed)}ms`
        );
        mainWindow?.webContents.send("contacts:synced", result);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Main] Contacts sync error:", message);
    }
  });

  watcher.on("error", (err) => {
    console.error("[Main] Contacts watcher error:", err.message);
  });

  watcher.start();
  console.log("[Main] Contacts watcher started");
}

app.whenReady().then(() => {
  // Initialize auth with WorkOS client ID
  initAuth(WORKOS_CLIENT_ID);

  // Set up IPC handlers before creating window
  setupAuthIpcHandlers();
  setupSyncIpcHandlers();

  createWindow();

  // Set up social IPC handlers after window is created (needs mainWindow reference)
  setupSocialIpcHandlers(mainWindow);

  // Start background sync
  startBackgroundSync();

  // Check initial auth state and notify renderer once window is ready
  mainWindow?.webContents.once("did-finish-load", () => {
    // Apply Liquid Glass effect on macOS Tahoe+
    if (mainWindow && isTahoe()) {
      try {
        liquidGlass.addView(mainWindow.getNativeWindowHandle(), {
          cornerRadius: 12,
          tintColor: "#00000010",
        });
      } catch (err) {
        console.error("[Main] Failed to apply Liquid Glass effect:", err);
      }
    }

    const authState = getAuthState();
    mainWindow?.webContents.send("auth:stateChanged", authState);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", async () => {
  getSyncManager().stop();
  getContactsWatcher().stop();
  try {
    getMessageQueueProcessor().stop();
  } catch {
    // Processor may not be initialized
  }
  try {
    await getReactiveConvexClient().close();
  } catch {
    // Client may not be initialized
  }
  try {
    await getHeartbeatManager().stop();
  } catch {
    // Heartbeat may not be initialized
  }
  // Clean up social scraper browser instances
  await cleanupSocialScrapers();
});
