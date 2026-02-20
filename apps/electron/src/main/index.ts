// Load env vars FIRST before any other imports
import "./env.js";

// Catch unhandled promise rejections to prevent silent crashes
process.on("unhandledRejection", (reason) => {
  console.error("[Main] Unhandled rejection:", reason);
});

import { join } from "node:path";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@cued/convex";
import { electronEnv } from "@cued/env/electron";
import {
  initAuth,
  getAuthState,
  getValidAccessToken,
  forceRefreshToken,
  startDeviceAuth,
  signOut,
  setOnTokenRefreshed,
} from "./auth";
import { getIMessageSyncManager } from "./platforms/imessage";
import { getContactsWatcher } from "./platforms/contacts";
import { getHeartbeatManager } from "./sync/presence";
import {
  setupAllSyncIpcHandlers,
  cleanupSyncManagers,
  getLinkedInScraper,
  getTwitterScraper,
} from "./ipc/sync";
import { getMessageQueueProcessor } from "./queue/message-queue-processor";
import { getConvexClient } from "./convex-client";
import { getSyncEngine } from "./sync/engine";
import { createAllSyncFunctions } from "./sync/sync-functions";
import { getIMessageWatcher } from "./sync/triggers/fsevents";
import { getTrayManager, type TrayStatus } from "./tray";
import { getPowerManager } from "./power";
import { getSettingsManager, SettingsManager } from "./settings";
import { initAutoUpdater, stopAutoUpdater, quitAndInstall } from "./auto-updater";
import { loadNativeModule } from "./native-module-loader";
import {
  checkFullDiskAccess,
  setupPermissionIpcHandlers,
  requestContactsAccessOnStartup,
} from "./ipc/permissions";

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

type LiquidGlassModule = {
  addView: (
    nativeWindowHandle: Buffer,
    options: { cornerRadius?: number; tintColor?: string }
  ) => void;
};

let liquidGlassModule: LiquidGlassModule | null | undefined;

function loadLiquidGlass(): LiquidGlassModule | null {
  if (liquidGlassModule !== undefined) {
    return liquidGlassModule;
  }

  try {
    const mod = loadNativeModule<{ default?: LiquidGlassModule } | LiquidGlassModule>(
      "electron-liquid-glass",
      { fallbackEntrypoint: "dist/index.cjs" }
    );
    liquidGlassModule = ((mod as { default?: LiquidGlassModule }).default ??
      mod) as LiquidGlassModule;
    return liquidGlassModule;
  } catch (error) {
    console.warn(
      "[Main] electron-liquid-glass is unavailable; continuing without Liquid Glass effect.",
      error
    );
    liquidGlassModule = null;
    return null;
  }
}

/**
 * Renderer diagnostics piped to main process logs.
 * Helps debug blank/empty window states without opening devtools.
 */
function attachRendererDebugLogging(window: BrowserWindow): void {
  const wc = window.webContents;

  if (electronEnv.NODE_ENV === "development") {
    wc.on("did-start-loading", () => {
      console.log("[Renderer] did-start-loading");
    });

    wc.on("dom-ready", () => {
      console.log("[Renderer] dom-ready");
    });

    wc.on("did-finish-load", () => {
      console.log("[Renderer] did-finish-load", wc.getURL());
    });
  }

  wc.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    console.error("[Renderer] did-fail-load", {
      code,
      description,
      isMainFrame,
      url,
    });
  });

  wc.on("render-process-gone", (_event, details) => {
    console.error("[Renderer] render-process-gone", details);
  });

  wc.on("console-message", (_event, detailsOrLevel, message, line, sourceId) => {
    let level: number;
    let text: string;
    let lineNumber: number;
    let source: string;

    if (typeof detailsOrLevel === "object" && detailsOrLevel !== null) {
      const details = detailsOrLevel as {
        level?: number;
        lineNumber?: number;
        message?: string;
        sourceId?: string;
      };
      level = details.level ?? 0;
      text = details.message ?? "";
      lineNumber = details.lineNumber ?? 0;
      source = details.sourceId ?? "";
    } else {
      level = Number(detailsOrLevel ?? 0);
      text = message ?? "";
      lineNumber = line ?? 0;
      source = sourceId ?? "";
    }

    const levelMap = {
      0: "LOG",
      1: "WARN",
      2: "ERROR",
      3: "DEBUG",
      4: "INFO",
    } as const;
    const label = levelMap[level as keyof typeof levelMap] ?? `LEVEL_${level}`;
    console.log(`[RendererConsole:${label}] ${text} (${source}:${lineNumber})`);
  });
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

  attachRendererDebugLogging(mainWindow);

  // Apply Liquid Glass effect on macOS Tahoe+
  if (useLiquidGlass) {
    mainWindow.setWindowButtonVisibility(true);
  }

  // In development, load from dev server (prefer electron-vite's injected URL)
  // In production, load from built files
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else if (electronEnv.NODE_ENV === "development") {
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

          // Initialize/start sync engine if not running (e.g., first login or after sign-out)
          const engine = getSyncEngine();
          const triggered = engine.syncNow();
          if (!triggered) {
            console.log("[Main] Sync engine not running - starting background sync");
            await startBackgroundSync();
          }
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
    // Stop the XState sync engine
    const engine = getSyncEngine();
    engine.stop();
    mainWindow?.webContents.send("auth:stateChanged", {
      isAuthenticated: false,
      user: null,
    });
  });

  // Get access token for renderer authentication
  ipcMain.handle("auth:getAccessToken", async (_event, forceRefresh = false) => {
    return await getValidAccessToken(Boolean(forceRefresh));
  });
}

function setupConfigIpcHandlers(): void {
  ipcMain.handle("config:getConvexUrl", () => CONVEX_URL);
  ipcMain.handle("config:getAppUrl", () => electronEnv.API_BASE_URL ?? "http://localhost:3000");
}

function setupShellIpcHandlers(): void {
  ipcMain.handle("shell:openExternal", async (_event, url: string) => {
    // Validate URL scheme to prevent arbitrary protocol handlers
    try {
      const parsed = new URL(url);
      const allowedSchemes = electronEnv.NODE_ENV === "development"
        ? ["https:", "http:", "imessage:", "slack:", "mailto:"]
        : ["https:", "imessage:", "slack:", "mailto:"];

      if (!allowedSchemes.includes(parsed.protocol)) {
        console.warn(`[Main] Rejected openExternal for non-allowed scheme: ${parsed.protocol}`);
        return false;
      }

      await shell.openExternal(url);
      return true;
    } catch (error) {
      console.warn(`[Main] Rejected openExternal for invalid URL: ${url}`);
      return false;
    }
  });
}

/**
 * Safely execute cleanup function, logging warnings on failure.
 */
async function safeCleanup(fn: () => void | Promise<void>, name: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Main] Cleanup failed for ${name}:`, message);
  }
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

    // Initialize the XState sync engine
    const engine = getSyncEngine({
      enableInspector: electronEnv.NODE_ENV === "development",
    });
    engine.initialize();

    // Set up progress callback for tray and renderer
    engine.setProgressCallback((progress) => {
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
        powerManager.stopPreventingSleep();
      } else {
        powerManager.stopPreventingSleep();
      }

      trayManager.updateStatus(
        status,
        progress.lastSyncAt ? new Date(progress.lastSyncAt) : undefined
      );

      // Notify renderer of unified sync progress
      mainWindow?.webContents.send("sync:progress", progress);
    });

    // Initialize iMessage sync manager (needed for runSync calls)
    getIMessageSyncManager();

    // Configure and start the unified message queue processor
    const convexClient = getConvexClient();
    convexClient.setTokenProvider(getValidAccessToken);
    convexClient.setAuthInvalidCallback(async () => {
      console.log("[Main] ConvexClient auth invalid, attempting token refresh...");
      const token = await forceRefreshToken();
      if (token) {
        // Refresh succeeded - onTokenRefreshedCallback already notified the renderer
        console.log("[Main] Token refreshed after auth invalid");
        return;
      }
      // Refresh truly failed (e.g., refresh token expired) - notify renderer
      console.log("[Main] Token refresh failed, notifying renderer of auth loss");
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

    // Start contacts watcher for incremental changes
    startContactsWatcher();

    // Register all sync functions with the engine
    const registrations = await createAllSyncFunctions({
      getAuthToken: getValidAccessToken,
      linkedInScraper: getLinkedInScraper(),
      twitterScraper: getTwitterScraper(),
    });

    for (const reg of registrations) {
      engine.registerSync(reg.syncType, reg.syncFn, reg.workspaceId);
    }

    // Start iMessage file watcher for event-driven sync
    const imessageWatcher = getIMessageWatcher();
    imessageWatcher.on("change", () => {
      console.log("[Main] iMessage DB changed, triggering sync");
      engine.syncNow();
    });
    imessageWatcher.start();

    // Start the sync engine (runs initial sync and starts timers)
    engine.start();
    console.log("[Main] XState sync engine started");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Main] Failed to start background sync:", message);
    // Don't crash the app if sync fails to start
  }
}

/**
 * Start watching for contacts changes and trigger sync when detected.
 */
function startContactsWatcher(): void {
  const watcher = getContactsWatcher();

  watcher.on("change", () => {
    console.log("[Main] Contacts changed, triggering sync...");
    try {
      // Trigger immediate sync via XState engine
      const engine = getSyncEngine();
      engine.syncNow();
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
  setupConfigIpcHandlers();
  setupShellIpcHandlers();
  setupPermissionIpcHandlers();

  createWindow();

  // Initialize auto-updater in production
  if (electronEnv.NODE_ENV !== "development" && mainWindow) {
    initAutoUpdater(mainWindow);
  }
  ipcMain.handle("updater:quitAndInstall", () => quitAndInstall());

  // Initialize tray manager with callbacks
  const trayManager = getTrayManager({
    onShowWindow: () => {
      mainWindow?.show();
      mainWindow?.focus();
      if (process.platform === "darwin") {
        app.dock?.show();
      }
    },
    onSyncNow: () => {
      const engine = getSyncEngine();
      engine.syncNow();
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
      const engine = getSyncEngine();
      engine.syncNow();
    },
  });
  powerManager.setMainWindow(mainWindow);
  powerManager.setupIpcHandlers();

  // Set up unified sync IPC handlers (iMessage, LinkedIn, Slack) after window is created
  setupAllSyncIpcHandlers(mainWindow);

  // Start background sync
  startBackgroundSync();

  // Check initial auth state and notify renderer once window is ready.
  // This handles the race where did-finish-load can fire before listener registration.
  let windowReadyHandled = false;
  const onMainWindowReady = async () => {
    if (windowReadyHandled) return;
    windowReadyHandled = true;

    const fullDiskAccessGranted = checkFullDiskAccess();
    console.log(
      `[Main] Full Disk Access ${fullDiskAccessGranted ? "granted" : "missing"} on startup`
    );

    // Trigger native macOS Contacts permission prompt (must happen after window is visible)
    await requestContactsAccessOnStartup();
    // Apply Liquid Glass effect on macOS Tahoe+
    if (mainWindow && isTahoe()) {
      try {
        const liquidGlass = loadLiquidGlass();
        liquidGlass?.addView(mainWindow.getNativeWindowHandle(), {
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
  };

  if (mainWindow?.webContents.isLoading()) {
    mainWindow.webContents.once("did-finish-load", () => {
      void onMainWindowReady();
    });
  } else {
    void onMainWindowReady();
  }

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
  // Stop sync engine and watchers
  getSyncEngine().stop();
  getIMessageWatcher().stop();
  getContactsWatcher().stop();
  stopAutoUpdater();

  // Cleanup services (may not be initialized)
  await safeCleanup(() => getMessageQueueProcessor().stop(), "MessageQueueProcessor");
  await safeCleanup(() => getConvexClient().close(), "ConvexClient");
  await safeCleanup(() => getHeartbeatManager().stop(), "HeartbeatManager");
  await safeCleanup(() => getTrayManager().destroy(), "TrayManager");
  await safeCleanup(() => getPowerManager().destroy(), "PowerManager");
  await cleanupSyncManagers();
});
