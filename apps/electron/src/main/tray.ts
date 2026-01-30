/**
 * TrayManager - System tray icon and context menu for Cued.
 *
 * Features:
 * - System tray icon with template image for macOS (adapts to light/dark mode)
 * - Context menu with Show/Hide, Sync Now, Preferences, Quit
 * - Dynamic tooltip showing sync status
 * - Click handler to toggle window visibility
 */

import { Tray, Menu, nativeImage, app, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import * as path from "node:path";

export type TrayStatus = "idle" | "syncing" | "error";

export interface TrayManagerOptions {
  onShowWindow?: () => void;
  onSyncNow?: () => void;
  onPreferences?: () => void;
  onQuit?: () => void;
}

export class TrayManager {
  private tray: Tray | null = null;
  private status: TrayStatus = "idle";
  private lastSyncTime: Date | null = null;
  private options: TrayManagerOptions;
  private mainWindow: BrowserWindow | null = null;

  constructor(options: TrayManagerOptions = {}) {
    this.options = options;
  }

  /**
   * Create and initialize the system tray icon.
   */
  create(): void {
    if (this.tray) return;

    const icon = this.createTrayIcon();

    try {
      this.tray = new Tray(icon);
      this.tray.setToolTip("Cued");
      this.updateContextMenu();
      this.tray.on("click", () => this.showWindow());
    } catch (e) {
      console.error("[TrayManager] Failed to create tray:", e);
    }
  }

  /**
   * Set reference to main window for show/hide functionality.
   */
  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  /**
   * Create the tray icon using nativeImage.
   * Uses a template image approach for macOS (16x16 base, auto-scales for retina).
   */
  private createTrayIcon(): Electron.NativeImage {
    const resourcesPath = app.isPackaged
      ? path.join(process.resourcesPath, "resources")
      : path.join(app.getAppPath(), "resources");

    const iconPath = path.join(resourcesPath, "trayIconTemplate.png");

    try {
      const icon = nativeImage.createFromPath(iconPath);
      if (!icon.isEmpty()) {
        icon.setTemplateImage(true);
        return icon;
      }
    } catch {
      // Fall through to fallback icon
    }

    return this.createFallbackIcon();
  }

  /**
   * Create a fallback icon programmatically using raw pixel data.
   * Creates a 16x16 template icon (black circle on transparent background).
   */
  private createFallbackIcon(): Electron.NativeImage {
    // Create a 16x16 RGBA bitmap (macOS standard menu bar icon size)
    const size = 16;
    const buffer = Buffer.alloc(size * size * 4); // RGBA

    // Draw a filled circle
    const cx = size / 2;
    const cy = size / 2;
    const radius = 6;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);

        if (dist <= radius) {
          // Black pixel (template images use black for the shape)
          buffer[idx] = 0; // R
          buffer[idx + 1] = 0; // G
          buffer[idx + 2] = 0; // B
          buffer[idx + 3] = 255; // A (fully opaque)
        } else {
          // Transparent pixel
          buffer[idx] = 0;
          buffer[idx + 1] = 0;
          buffer[idx + 2] = 0;
          buffer[idx + 3] = 0; // A (fully transparent)
        }
      }
    }

    const icon = nativeImage.createFromBuffer(buffer, {
      width: size,
      height: size,
    });
    icon.setTemplateImage(true);
    return icon;
  }

  /**
   * Show and focus the main window.
   * Clicking tray always shows the window (use context menu to hide/quit).
   */
  private showWindow(): void {
    if (!this.mainWindow) {
      this.options.onShowWindow?.();
      return;
    }

    this.mainWindow.show();
    this.mainWindow.focus();
  }

  /**
   * Update the tray tooltip and context menu based on current status.
   */
  updateStatus(status: TrayStatus, lastSyncTime?: Date): void {
    this.status = status;
    if (lastSyncTime) {
      this.lastSyncTime = lastSyncTime;
    }

    this.updateTooltip();
    this.updateContextMenu();
  }

  /**
   * Update the tooltip based on current status.
   */
  private updateTooltip(): void {
    if (!this.tray) return;

    let tooltip = "Cued";
    switch (this.status) {
      case "syncing":
        tooltip = "Cued - Syncing...";
        break;
      case "error":
        tooltip = "Cued - Sync Error";
        break;
      case "idle":
        if (this.lastSyncTime) {
          const timeAgo = this.formatTimeAgo(this.lastSyncTime);
          tooltip = `Cued - Last sync: ${timeAgo}`;
        }
        break;
    }

    this.tray.setToolTip(tooltip);
  }

  /**
   * Format a date as relative time (e.g., "2 minutes ago").
   */
  private formatTimeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
    return `${Math.floor(seconds / 86400)} days ago`;
  }

  /**
   * Build and set the context menu.
   */
  private updateContextMenu(): void {
    if (!this.tray) return;

    const menuTemplate: MenuItemConstructorOptions[] = [
      {
        label: "Show Cued",
        click: () => {
          // Delegate to callback which handles dock visibility on macOS
          this.options.onShowWindow?.();
        },
      },
      {
        label: this.status === "syncing" ? "Syncing..." : "Sync Now",
        enabled: this.status !== "syncing",
        click: () => this.options.onSyncNow?.(),
      },
      { type: "separator" },
      {
        label: "Preferences...",
        click: () => this.options.onPreferences?.(),
      },
      { type: "separator" },
      {
        label: "Quit Cued",
        click: () => {
          this.options.onQuit?.();
          app.quit();
        },
      },
    ];

    // Add last sync time to menu if available
    if (this.lastSyncTime && this.status === "idle") {
      menuTemplate.splice(2, 0, {
        label: `Last sync: ${this.formatTimeAgo(this.lastSyncTime)}`,
        enabled: false,
      });
    }

    const contextMenu = Menu.buildFromTemplate(menuTemplate);
    this.tray.setContextMenu(contextMenu);
  }

  /**
   * Destroy the tray icon.
   */
  destroy(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }

  /**
   * Get the tray instance.
   */
  getTray(): Tray | null {
    return this.tray;
  }
}

// Singleton instance
let trayManager: TrayManager | null = null;

export function getTrayManager(options?: TrayManagerOptions): TrayManager {
  if (!trayManager) {
    trayManager = new TrayManager(options);
  }
  return trayManager;
}
