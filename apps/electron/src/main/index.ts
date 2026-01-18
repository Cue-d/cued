import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@prm/convex";
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
import { getIMessageSender } from "./sync/imessage-sender";
import { getHeartbeatManager } from "./sync/presence";
import { setupSocialIpcHandlers, cleanupSocialScrapers } from "./ipc/social";

const CONVEX_URL =
  process.env.CONVEX_URL || "https://perceptive-lobster-290.convex.cloud";

// WorkOS Client ID - should match web app config
// In production, this would be loaded from a config file or env
const WORKOS_CLIENT_ID =
  process.env.WORKOS_CLIENT_ID || "client_01JZDHMFDC22NTPTWYKPR32P73";

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // In development, load from dev server
  // In production, load from built files
  if (process.env.NODE_ENV === "development") {
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

    const syncManager = getSyncManager({
      getAuthToken: getValidAccessToken,
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
      // Wire contacts sync for recovery flows
      syncContacts: async () => {
        const result = await syncContactsToConvex(getValidAccessToken, true);
        return { contactsCount: result.contactsCount };
      },
    });

    syncManager.start();
    console.log("[Main] Background sync started");

    // Start contacts watcher for incremental contact sync
    startContactsWatcher();

    // Start iMessage sender to poll for pending sends
    const imessageSender = getIMessageSender(getValidAccessToken);
    imessageSender.start(5000); // Poll every 5 seconds
    console.log("[Main] iMessage sender started");

    // Start presence heartbeat for mobile to detect desktop online status
    const heartbeatManager = getHeartbeatManager(getValidAccessToken);
    heartbeatManager.start();
    console.log("[Main] Presence heartbeat started");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Main] Failed to start background sync:", message);
    // Don't crash the app if sync fails to start
  }
}

/**
 * Start watching for contacts changes and sync when detected.
 */
function startContactsWatcher(): void {
  const watcher = getContactsWatcher();

  watcher.on("change", async () => {
    console.log("[Main] Contacts changed, syncing to Convex...");
    try {
      const result = await syncContactsToConvex(getValidAccessToken, true);
      console.log(
        `[Main] Contacts sync complete: ${result.contactsCount} contacts in ${Math.round(result.elapsed)}ms`
      );
      mainWindow?.webContents.send("contacts:synced", result);
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
    getIMessageSender().stop();
  } catch {
    // Sender may not be initialized
  }
  try {
    await getHeartbeatManager().stop();
  } catch {
    // Heartbeat may not be initialized
  }
  // Clean up social scraper browser instances
  await cleanupSocialScrapers();
});
