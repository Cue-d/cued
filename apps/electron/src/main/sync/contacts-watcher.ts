/**
 * Watches for macOS Contacts.app changes using the prm-contacts Swift CLI.
 *
 * The Swift CLI outputs JSON lines when contacts change, which we parse and
 * emit as events. Falls back to hourly polling if watch mode is unavailable.
 */

import { ChildProcess, spawn } from "child_process";
import { EventEmitter } from "events";
import { isSwiftContactsAvailable, getContactsManager } from "./contacts";

/** Watch event types from the Swift CLI */
interface WatchEvent {
  type: "started" | "changed" | "error";
  timestamp: string;
  message: string | null;
}

/** ContactsWatcher events */
export interface ContactsWatcherEvents {
  change: [];
  error: [Error];
  started: [];
  stopped: [];
}

/** One hour in milliseconds */
const HOURLY_INTERVAL_MS = 60 * 60 * 1000;

/** Restart delay after crash */
const RESTART_DELAY_MS = 5000;

/**
 * Watches for contacts changes via Swift CLI or hourly fallback.
 */
export class ContactsWatcher extends EventEmitter<ContactsWatcherEvents> {
  private process: ChildProcess | null = null;
  private fallbackInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private restartTimeout: ReturnType<typeof setTimeout> | null = null;
  private buffer = "";

  /**
   * Start watching for contact changes.
   * Uses Swift CLI watch mode if available, otherwise falls back to hourly polling.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    if (isSwiftContactsAvailable()) {
      this.startWatchProcess();
    } else {
      console.log("[ContactsWatcher] Swift CLI unavailable, using hourly fallback");
      this.startFallbackPolling();
    }
  }

  /**
   * Stop watching for contact changes.
   */
  stop(): void {
    this.isRunning = false;
    this.stopWatchProcess();
    this.stopFallbackPolling();
    this.emit("stopped");
  }

  /**
   * Check if the watcher is currently running.
   */
  isWatching(): boolean {
    return this.isRunning;
  }

  private startWatchProcess(): void {
    const binaryPath = getContactsManager().getBinaryPath();

    try {
      this.process = spawn(binaryPath, ["--watch"], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.process.stdout?.on("data", (data: Buffer) => {
        this.handleOutput(data.toString());
      });

      this.process.stderr?.on("data", (data: Buffer) => {
        console.error("[ContactsWatcher] stderr:", data.toString().trim());
      });

      this.process.on("error", (err) => {
        console.error("[ContactsWatcher] Process error:", err.message);
        this.emit("error", err);
        this.scheduleRestart();
      });

      this.process.on("exit", (code, signal) => {
        console.log(`[ContactsWatcher] Process exited (code=${code}, signal=${signal})`);
        this.process = null;
        if (this.isRunning) {
          this.scheduleRestart();
        }
      });

      console.log("[ContactsWatcher] Started watch process");
    } catch (err) {
      console.error("[ContactsWatcher] Failed to start:", err);
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      this.startFallbackPolling();
    }
  }

  private stopWatchProcess(): void {
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }

    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
  }

  private scheduleRestart(): void {
    if (!this.isRunning || this.restartTimeout) return;

    console.log(`[ContactsWatcher] Restarting in ${RESTART_DELAY_MS}ms...`);
    this.restartTimeout = setTimeout(() => {
      this.restartTimeout = null;
      if (this.isRunning) {
        this.startWatchProcess();
      }
    }, RESTART_DELAY_MS);
  }

  private handleOutput(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as WatchEvent;
        this.handleEvent(event);
      } catch {
        console.warn("[ContactsWatcher] Invalid JSON line:", line);
      }
    }
  }

  private handleEvent(event: WatchEvent): void {
    switch (event.type) {
      case "started":
        console.log("[ContactsWatcher] Watch started:", event.message);
        this.emit("started");
        break;
      case "changed":
        console.log("[ContactsWatcher] Contacts changed at", event.timestamp);
        this.emit("change");
        break;
      case "error":
        console.error("[ContactsWatcher] Error:", event.message);
        this.emit("error", new Error(event.message || "Unknown error"));
        break;
    }
  }

  private startFallbackPolling(): void {
    if (this.fallbackInterval) return;

    // Emit initial change to trigger first sync
    this.emit("started");
    this.emit("change");

    this.fallbackInterval = setInterval(() => {
      if (this.isRunning) {
        console.log("[ContactsWatcher] Hourly fallback sync");
        this.emit("change");
      }
    }, HOURLY_INTERVAL_MS);

    console.log("[ContactsWatcher] Started hourly fallback polling");
  }

  private stopFallbackPolling(): void {
    if (this.fallbackInterval) {
      clearInterval(this.fallbackInterval);
      this.fallbackInterval = null;
    }
  }
}

/** Singleton instance */
let defaultWatcher: ContactsWatcher | null = null;

/**
 * Get the default ContactsWatcher instance.
 */
export function getContactsWatcher(): ContactsWatcher {
  if (!defaultWatcher) {
    defaultWatcher = new ContactsWatcher();
  }
  return defaultWatcher;
}
