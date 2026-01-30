/**
 * PowerManager - Sleep prevention and power event handling for Cued.
 *
 * Features:
 * - Prevent system sleep during active sync using powerSaveBlocker
 * - Detect and respond to sleep/wake events
 * - IPC events for power state changes
 */

import { powerSaveBlocker, powerMonitor, ipcMain, type BrowserWindow } from "electron";

export type PowerEvent = "suspend" | "resume";

export interface PowerManagerOptions {
  onSuspend?: () => void;
  onResume?: () => void;
}

export class PowerManager {
  private blockerId: number | null = null;
  private options: PowerManagerOptions;
  private mainWindow: BrowserWindow | null = null;
  private isSetup = false;
  private ipcHandlersSetup = false;

  constructor(options: PowerManagerOptions = {}) {
    this.options = options;
    this.setupSleepWakeHandlers();
  }

  /**
   * Set reference to main window for IPC events.
   */
  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  /**
   * Start preventing system sleep.
   * Uses 'prevent-app-suspension' mode which keeps the app running
   * but allows the display to turn off.
   */
  startPreventingSleep(): void {
    if (this.blockerId !== null) return;
    this.blockerId = powerSaveBlocker.start("prevent-app-suspension");
  }

  /**
   * Stop preventing system sleep.
   */
  stopPreventingSleep(): void {
    if (this.blockerId === null) return;
    powerSaveBlocker.stop(this.blockerId);
    this.blockerId = null;
  }

  /**
   * Check if currently preventing sleep.
   */
  isPreventingSleep(): boolean {
    return this.blockerId !== null && powerSaveBlocker.isStarted(this.blockerId);
  }

  /**
   * Set up handlers for system sleep/wake events.
   */
  private setupSleepWakeHandlers(): void {
    if (this.isSetup) return;
    this.isSetup = true;

    powerMonitor.on("suspend", () => {
      this.stopPreventingSleep();
      this.mainWindow?.webContents.send("power:suspend");
      this.options.onSuspend?.();
    });

    powerMonitor.on("resume", () => {
      this.mainWindow?.webContents.send("power:resume");
      this.options.onResume?.();
    });

    console.log("[PowerManager] Initialized");
  }

  /**
   * Set up IPC handlers for renderer to query power state.
   */
  setupIpcHandlers(): void {
    if (this.ipcHandlersSetup) return;
    this.ipcHandlersSetup = true;

    ipcMain.handle("power:isPreventingSleep", () => {
      return this.isPreventingSleep();
    });

    ipcMain.handle("power:getIdleState", (_, idleThreshold: number) => {
      return powerMonitor.getSystemIdleState(idleThreshold);
    });

    ipcMain.handle("power:getIdleTime", () => {
      return powerMonitor.getSystemIdleTime();
    });
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    this.stopPreventingSleep();
  }
}

// Singleton instance
let powerManager: PowerManager | null = null;

export function getPowerManager(options?: PowerManagerOptions): PowerManager {
  if (!powerManager) {
    powerManager = new PowerManager(options);
  }
  return powerManager;
}
