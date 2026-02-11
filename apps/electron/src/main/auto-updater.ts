import { BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

let checkInterval: ReturnType<typeof setInterval> | null = null;

export function initAutoUpdater(win: BrowserWindow): void {
  // Point to the public releases repo — no token needed
  autoUpdater.setFeedURL({
    provider: "github",
    owner: "Cue-d",
    repo: "cued-releases",
  });

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    console.log("[AutoUpdater] Update available:", info.version);
    if (!win.isDestroyed()) {
      win.webContents.send("updater:status", {
        status: "downloading",
        version: info.version,
      });
    }
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log("[AutoUpdater] Update downloaded:", info.version);
    if (!win.isDestroyed()) {
      win.webContents.send("updater:status", {
        status: "ready",
        version: info.version,
      });
    }
  });

  autoUpdater.on("error", (err) => {
    console.error("[AutoUpdater] Error:", err.message);
    if (!win.isDestroyed()) {
      win.webContents.send("updater:status", {
        status: "error",
      });
    }
  });

  // Initial check
  autoUpdater.checkForUpdates().catch((err) => {
    console.warn("[AutoUpdater] Initial check failed:", err.message);
  });

  // Periodic checks
  checkInterval = setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn("[AutoUpdater] Periodic check failed:", err.message);
    });
  }, CHECK_INTERVAL_MS);
}

export function stopAutoUpdater(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}
