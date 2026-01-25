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
  forceRefreshToken,
  startDeviceAuth,
  signOut,
  setOnTokenRefreshed,
} from "./auth";
import { getSyncManager, type SyncProgress } from "./sync/sync-manager";
import { getContactsWatcher } from "./sync/contacts-watcher";
import { syncContactsToConvex } from "./sync/contacts-sync";
import { getHeartbeatManager } from "./sync/presence";
import { setupSocialIpcHandlers, cleanupSocialScrapers, getLinkedInScraper } from "./ipc/social";
import { getLinkedInSyncManager } from "./sync/linkedin-sync";
import { getMessageQueueProcessor } from "./queue/message-queue-processor";
import { getReactiveConvexClient } from "./convex-client";
import { getSlackSyncManager } from "./sync/slack-sync";
import { getAllSlackCredentials } from "./auth/slack-credentials";
import { getSyncCoordinator } from "./sync/sync-coordinator";
import { getTrayManager, type TrayStatus } from "./tray";
import { getPowerManager } from "./power";
import { getSettingsManager, SettingsManager } from "./settings";

const CONVEX_URL = electronEnv.CONVEX_URL;
const WORKOS_CLIENT_ID = electronEnv.WORKOS_CLIENT_ID;

let mainWindow: BrowserWindow | null = null;

// Extend app with isQuitting flag for proper quit handling
declare global {
  namespace Electron {
    interface App {
      isQuitting?: boolean;
    }
  }
}

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
  const launchedHidden = SettingsManager.wasLaunchedHidden();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    transparent: useLiquidGlass,
    titleBarStyle: useLiquidGlass ? "hiddenInset" : "default",
    backgroundColor: useLiquidGlass ? undefined : "#1a1a1a",
    show: !launchedHidden, // Don't show if launched with --hidden
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

  // On macOS, hide to tray instead of closing when user clicks X
  if (process.platform === "darwin") {
    mainWindow.on("close", (event) => {
      // Only hide if app is not quitting and tray exists
      if (!app.isQuitting && getTrayManager().getTray()) {
        event.preventDefault();
        mainWindow?.hide();
        // Hide from dock when minimized to tray
        app.dock?.hide();
      }
    });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Show dock icon when window becomes visible
  mainWindow.on("show", () => {
    if (process.platform === "darwin") {
      app.dock?.show();
    }
  });

  // Log startup mode
  if (launchedHidden) {
    console.log("[Main] App started hidden (--hidden flag or auto-launch)");
  }
}

function setupAuthIpcHandlers(): void {
  // Get current auth state (tries to refresh token if expired)
  ipcMain.handle("auth:getState", async () => {
    // Try to get a valid token first - this triggers refresh if access token expired
    // but we have a valid refresh token. This ensures we return accurate auth state.
    const token = await getValidAccessToken();
    if (token) {
      return getAuthState();
    }
    return { isAuthenticated: false, user: null };
  });

  // Start device authorization flow
  ipcMain.handle("auth:startLogin", async () => {
    try {
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

          // Start sync (uses centralized auth from auth-manager)
          const syncManager = getSyncManager();
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
    } catch (error) {
      // Handle errors that occur before callbacks are invoked (e.g., network errors)
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Main] Device auth failed:", message);
      mainWindow?.webContents.send("auth:stateChanged", {
        isAuthenticated: false,
        user: null,
        error: message,
      });
    }
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
    // Try to get a valid token - this will refresh if the access token expired
    // but we have a valid refresh token. The onTokenRefreshed callback will
    // notify the renderer if refresh succeeds.
    const token = await getValidAccessToken();
    if (!token) {
      console.log("[Main] No valid auth token, skipping background sync");
      return;
    }
    console.log("[Main] Auth token valid, starting background sync");

    // Get managers for integration
    const trayManager = getTrayManager();
    const powerManager = getPowerManager();
    const settingsManager = getSettingsManager();

    // Initialize SyncCoordinator FIRST - this manages all sync operations
    // Token refresh is handled by auth-manager which checks actual expiry
    const coordinator = getSyncCoordinator({
      getAuthToken: getValidAccessToken,
      onAuthInvalid: () => {
        console.log("[Main] Auth invalid from coordinator, notifying renderer");
        mainWindow?.webContents.send("auth:stateChanged", {
          isAuthenticated: false,
          user: null,
        });
      },
    });
    const syncManager = getSyncManager({
      onProgress: (progress: SyncProgress) => {
        // Update tray status based on sync progress
        let status: TrayStatus = "idle";
        if (progress.status === "syncing") {
          status = "syncing";
          // Prevent sleep during sync if enabled in settings
          if (settingsManager.getPreventSleepWhileSyncing()) {
            powerManager.startPreventingSleep();
          }
        } else if (progress.status === "error") {
          status = "error";
          // Stop preventing sleep on error
          powerManager.stopPreventingSleep();
        } else {
          // Stop preventing sleep when idle
          powerManager.stopPreventingSleep();
        }

        trayManager.updateStatus(
          status,
          progress.lastSyncAt ? new Date(progress.lastSyncAt) : undefined
        );

        // Notify renderer of sync progress
        mainWindow?.webContents.send("sync:progress", progress);
      },
      // Wire contacts sync for recovery flows - goes through coordinator
      syncContacts: async () => {
        let contactsCount = 0;
        await coordinator.scheduleContactsSync(async () => {
          const result = await syncContactsToConvex(() => coordinator.getValidToken(), true);
          mainWindow?.webContents.send("contacts:synced", result);
          contactsCount = result.contactsCount;
        });
        return { contactsCount };
      },
    });

    // Run contacts sync BEFORE iMessage sync to ensure contactHandles exist,
    // preventing duplicate handles from race conditions.
    console.log("[Main] Running initial contacts sync...");
    try {
      await coordinator.scheduleContactsSync(async () => {
        const result = await syncContactsToConvex(() => coordinator.getValidToken(), true);
        console.log(`[Main] Initial contacts sync complete: ${result.contactsCount} contacts`);
        mainWindow?.webContents.send("contacts:synced", result);
      });
    } catch (err) {
      console.warn("[Main] Initial contacts sync failed (continuing anyway):", err);
    }

    // Now start iMessage sync - contactHandles already exist for known contacts
    syncManager.start();
    console.log("[Main] Background sync started");

    // Contacts watcher handles incremental changes going forward
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
    heartbeatManager.setForceRefreshCallback(forceRefreshToken);
    heartbeatManager.start();
    console.log("[Main] Presence heartbeat started");

    // Auto-start LinkedIn messaging sync if already logged in
    startLinkedInMessagingSync();

    // Auto-start Slack messaging sync if credentials are stored
    startSlackMessagingSync();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Main] Failed to start background sync:", message);
    // Don't crash the app if sync fails to start
  }
}

/**
 * Auto-start LinkedIn messaging sync if user is already logged in.
 * Uses singleton scraper to share browser lock with IPC handlers.
 */
async function startLinkedInMessagingSync(): Promise<void> {
  try {
    const scraper = getLinkedInScraper();
    const isLoggedIn = await scraper.checkLoginStatus();

    if (!isLoggedIn) {
      console.log("[Main] LinkedIn not logged in, skipping auto-start");
      return;
    }

    console.log("[Main] LinkedIn logged in, starting messaging sync...");

    // Get API client from scraper
    const apiClient = await scraper.getApiClient();

    // Configure sync manager (uses centralized auth from auth-manager)
    const syncManager = getLinkedInSyncManager();
    syncManager.setClient(apiClient);

    // Set up progress callback to notify renderer
    syncManager.setProgressCallback((progress) => {
      mainWindow?.webContents.send("social:linkedin:messagingSyncProgress", progress);
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
 * Auto-start Slack messaging sync if user has stored credentials.
 */
async function startSlackMessagingSync(): Promise<void> {
  try {
    const allCredentials = getAllSlackCredentials();

    if (allCredentials.length === 0) {
      console.log("[Main] No Slack credentials found, skipping auto-start");
      return;
    }

    console.log(`[Main] Found ${allCredentials.length} Slack workspace(s), starting sync...`);

    for (const creds of allCredentials) {
      const manager = getSlackSyncManager({ teamId: creds.teamId });

      // Initialize the manager (loads credentials, creates client)
      const initialized = await manager.initialize();
      if (!initialized) {
        console.log(`[Main] Slack manager for ${creds.teamName} failed to initialize`);
        continue;
      }

      // Set up progress callback to notify renderer (uses centralized auth from auth-manager)
      manager.setProgressCallback((progress) => {
        mainWindow?.webContents.send("social:slack:messagingSyncProgress", {
          ...progress,
          teamId: manager.getTeamId(),
        });
      });

      // Start sync
      await manager.start();
      console.log(`[Main] Slack messaging sync auto-started for ${creds.teamName}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.log("[Main] Slack auto-start failed (non-fatal):", message);
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

  // Initialize settings manager and set up IPC handlers
  const settingsManager = getSettingsManager();
  settingsManager.setupIpcHandlers();

  // Register callback to notify renderer when tokens are refreshed
  setOnTokenRefreshed((authState) => {
    console.log("[Main] Token refreshed, notifying renderer");
    mainWindow?.webContents.send("auth:stateChanged", authState);
  });

  // Set up IPC handlers before creating window
  setupAuthIpcHandlers();
  setupSyncIpcHandlers();

  createWindow();

  // Initialize tray manager with callbacks
  const trayManager = getTrayManager({
    onShowWindow: () => {
      mainWindow?.show();
      mainWindow?.focus();
      if (process.platform === "darwin") {
        app.dock?.show();
      }
    },
    onSyncNow: async () => {
      const manager = getSyncManager();
      await manager.runSync();
    },
    onPreferences: () => {
      // Show window and navigate to preferences
      mainWindow?.show();
      mainWindow?.focus();
      mainWindow?.webContents.send("navigate:preferences");
    },
    onQuit: () => {
      app.isQuitting = true;
    },
  });
  trayManager.create();
  trayManager.setMainWindow(mainWindow);

  // Initialize power manager with sleep/wake handlers
  const powerManager = getPowerManager({
    onSuspend: () => {
      // Pause sync on system suspend
      console.log("[Main] System suspended, sync will pause");
    },
    onResume: () => {
      // Trigger immediate sync on system resume
      console.log("[Main] System resumed, triggering sync");
      getSyncManager().runSync();
    },
  });
  powerManager.setMainWindow(mainWindow);
  powerManager.setupIpcHandlers();

  // Set up social IPC handlers after window is created (needs mainWindow reference)
  setupSocialIpcHandlers(mainWindow);

  // Start background sync
  startBackgroundSync();

  // Check initial auth state and notify renderer once window is ready
  mainWindow?.webContents.once("did-finish-load", async () => {
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

    // Try to get a valid token (which refreshes if needed) before checking auth state.
    // This ensures the renderer gets the correct auth state even if the access token
    // was expired but we have a valid refresh token.
    const token = await getValidAccessToken();
    if (token) {
      // Token is valid (possibly refreshed), send authenticated state
      const authState = getAuthState();
      mainWindow?.webContents.send("auth:stateChanged", authState);
    } else {
      // No valid token, send unauthenticated state
      mainWindow?.webContents.send("auth:stateChanged", {
        isAuthenticated: false,
        user: null,
      });
    }
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

app.on("before-quit", () => {
  app.isQuitting = true;
});

app.on("will-quit", async () => {
  // Gracefully stop services that are always initialized
  getSyncManager().stop();
  getContactsWatcher().stop();

  // Stop services that may not be initialized (ignore errors)
  const safeCleanup = async (fn: () => void | Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch {
      // Service may not be initialized
    }
  };

  await safeCleanup(() => getMessageQueueProcessor().stop());
  await safeCleanup(() => getReactiveConvexClient().close());
  await safeCleanup(() => getHeartbeatManager().stop());
  await safeCleanup(() => getTrayManager().destroy());
  await safeCleanup(() => getPowerManager().destroy());
  await cleanupSocialScrapers();
});
