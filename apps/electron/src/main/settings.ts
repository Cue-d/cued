/**
 * Settings manager for Cued Electron app.
 *
 * Features:
 * - Auto-launch on login configuration
 * - Persistent settings storage
 * - IPC handlers for renderer access
 */

import { app, ipcMain } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

export interface AppSettings {
  autoLaunchEnabled: boolean;
  startMinimized: boolean;
  preventSleepWhileSyncing: boolean;
  /** How many days of message history to sync on initial/full sync. */
  syncHistoryDays: number;
  onboardingCompleted: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  autoLaunchEnabled: false,
  startMinimized: false,
  preventSleepWhileSyncing: true,
  syncHistoryDays: 90,
  onboardingCompleted: false,
};

export class SettingsManager {
  private settings: AppSettings;
  private settingsPath: string;
  private ipcHandlersSetup = false;

  constructor() {
    this.settingsPath = path.join(app.getPath("userData"), "settings.json");
    this.settings = this.loadSettings();
  }

  /**
   * Load settings from disk or return defaults.
   */
  private loadSettings(): AppSettings {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const data = JSON.parse(fs.readFileSync(this.settingsPath, "utf-8"));
        return { ...DEFAULT_SETTINGS, ...data };
      }
    } catch (e) {
      console.warn("[SettingsManager] Failed to load settings:", e);
    }
    return { ...DEFAULT_SETTINGS };
  }

  /**
   * Save settings to disk.
   */
  private saveSettings(): void {
    try {
      const dir = path.dirname(this.settingsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2));
    } catch (e) {
      console.warn("[SettingsManager] Failed to save settings:", e);
    }
  }

  /**
   * Get all settings.
   */
  getSettings(): AppSettings {
    return { ...this.settings };
  }

  /**
   * Get auto-launch enabled state.
   */
  getAutoLaunch(): boolean {
    return this.settings.autoLaunchEnabled;
  }

  /**
   * Set auto-launch on login.
   * Uses Electron's setLoginItemSettings API.
   */
  setAutoLaunch(enabled: boolean): void {
    this.settings.autoLaunchEnabled = enabled;

    // Configure login item settings
    // Note: openAsHidden is deprecated on macOS 13+, but we still set it for older versions
    // The app checks for --hidden CLI arg instead for reliable hidden startup
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: enabled, // Deprecated but still useful for macOS < 13
      args: enabled ? ["--hidden"] : [],
    });

    this.saveSettings();
    console.log(`[SettingsManager] Auto-launch ${enabled ? "enabled" : "disabled"}`);
  }

  /**
   * Get start minimized setting.
   */
  getStartMinimized(): boolean {
    return this.settings.startMinimized;
  }

  /**
   * Set start minimized to tray.
   */
  setStartMinimized(enabled: boolean): void {
    this.setSetting("startMinimized", enabled, "Start minimized");
  }

  /**
   * Get prevent sleep while syncing setting.
   */
  getPreventSleepWhileSyncing(): boolean {
    return this.settings.preventSleepWhileSyncing;
  }

  /**
   * Set prevent sleep while syncing.
   */
  setPreventSleepWhileSyncing(enabled: boolean): void {
    this.setSetting("preventSleepWhileSyncing", enabled, "Prevent sleep while syncing");
  }

  /**
   * Get sync history days setting.
   */
  getSyncHistoryDays(): number {
    return this.settings.syncHistoryDays;
  }

  /**
   * Set how many days of history to sync.
   */
  setSyncHistoryDays(days: number): void {
    this.settings.syncHistoryDays = Math.max(1, Math.round(days));
    this.saveSettings();
    console.log(`[SettingsManager] Sync history days set to ${this.settings.syncHistoryDays}`);
  }

  /**
   * Get onboarding completion state.
   */
  getOnboardingCompleted(): boolean {
    return this.settings.onboardingCompleted;
  }

  /**
   * Set onboarding completion state.
   */
  setOnboardingCompleted(completed: boolean): void {
    this.setSetting("onboardingCompleted", completed, "Onboarding completion");
  }

  /**
   * Generic setter for boolean settings.
   */
  private setSetting(key: keyof AppSettings, enabled: boolean, label: string): void {
    (this.settings[key] as boolean) = enabled;
    this.saveSettings();
    console.log(`[SettingsManager] ${label} ${enabled ? "enabled" : "disabled"}`);
  }

  /**
   * Check if app was launched with --hidden flag.
   */
  static wasLaunchedHidden(): boolean {
    return process.argv.includes("--hidden");
  }

  /**
   * Get current login item settings from OS.
   */
  getLoginItemSettings(): Electron.LoginItemSettings {
    return app.getLoginItemSettings();
  }

  /**
   * Set up IPC handlers for renderer access.
   */
  setupIpcHandlers(): void {
    if (this.ipcHandlersSetup) return;
    this.ipcHandlersSetup = true;

    ipcMain.handle("settings:getAll", () => {
      return this.getSettings();
    });

    ipcMain.handle("settings:getAutoLaunch", () => {
      return this.getAutoLaunch();
    });

    ipcMain.handle("settings:setAutoLaunch", (_, enabled: boolean) => {
      this.setAutoLaunch(enabled);
      return this.getAutoLaunch();
    });

    ipcMain.handle("settings:getStartMinimized", () => {
      return this.getStartMinimized();
    });

    ipcMain.handle("settings:setStartMinimized", (_, enabled: boolean) => {
      this.setStartMinimized(enabled);
      return this.getStartMinimized();
    });

    ipcMain.handle("settings:getPreventSleepWhileSyncing", () => {
      return this.getPreventSleepWhileSyncing();
    });

    ipcMain.handle("settings:setPreventSleepWhileSyncing", (_, enabled: boolean) => {
      this.setPreventSleepWhileSyncing(enabled);
      return this.getPreventSleepWhileSyncing();
    });

    ipcMain.handle("settings:getLoginItemSettings", () => {
      return this.getLoginItemSettings();
    });

    ipcMain.handle("settings:getSyncHistoryDays", () => {
      return this.getSyncHistoryDays();
    });

    ipcMain.handle("settings:setSyncHistoryDays", (_, days: number) => {
      this.setSyncHistoryDays(days);
      return this.getSyncHistoryDays();
    });

    ipcMain.handle("settings:getOnboardingCompleted", () => {
      return this.getOnboardingCompleted();
    });

    ipcMain.handle("settings:setOnboardingCompleted", (_, completed: boolean) => {
      this.setOnboardingCompleted(completed);
      return this.getOnboardingCompleted();
    });
  }
}

// Singleton instance
let settingsManager: SettingsManager | null = null;

export function getSettingsManager(): SettingsManager {
  if (!settingsManager) {
    settingsManager = new SettingsManager();
  }
  return settingsManager;
}
