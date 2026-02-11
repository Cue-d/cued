/**
 * Watches for macOS Contacts.app changes using the node-mac-contacts listener.
 *
 * Listens for CNContactStoreDidChange notifications in-process and emits
 * change events so the sync engine can re-fetch contacts.
 * Falls back to hourly polling if the native listener is unavailable.
 */

import { EventEmitter } from "events";
import { loadNativeModule } from "../../native-module-loader";
import type { NodeMacContacts } from "./types";

/** One hour in milliseconds */
const FALLBACK_POLL_INTERVAL_MS = 60 * 60 * 1000;

/** ContactsWatcher events */
export interface ContactsWatcherEvents {
  change: [];
  error: [Error];
  started: [];
  stopped: [];
}

/**
 * Watches for contacts changes via native CNContactStore notifications.
 * Falls back to hourly polling if the native module fails to load.
 */
export class ContactsWatcher extends EventEmitter<ContactsWatcherEvents> {
  private isRunning = false;
  private contacts: NodeMacContacts | null = null;
  private fallbackInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Start watching for contact changes.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      this.contacts = loadNativeModule<NodeMacContacts>("node-mac-contacts");
      this.contacts.listener.setup();
      this.contacts.listener.on("contact-changed", () => {
        this.emit("change");
      });
      this.emit("started");
    } catch (err) {
      console.warn("[ContactsWatcher] Native listener unavailable, falling back to hourly polling:", err);
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      this.startFallbackPolling();
    }
  }

  /**
   * Stop watching for contact changes.
   */
  stop(): void {
    this.isRunning = false;
    if (this.contacts) {
      this.contacts.listener.remove();
      this.contacts = null;
    }
    this.stopFallbackPolling();
    this.emit("stopped");
  }

  /**
   * Check if the watcher is currently running.
   */
  isWatching(): boolean {
    return this.isRunning;
  }

  private startFallbackPolling(): void {
    if (this.fallbackInterval) return;

    // Emit initial change to trigger first sync
    this.emit("started");
    this.emit("change");

    this.fallbackInterval = setInterval(() => {
      if (this.isRunning) {
        this.emit("change");
      }
    }, FALLBACK_POLL_INTERVAL_MS);
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
