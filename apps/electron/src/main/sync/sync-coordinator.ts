/**
 * SyncCoordinator - Central orchestrator for all sync operations.
 *
 * Solves race conditions by:
 * 1. Serializing sync operations that touch shared data (contacts, contactHandles)
 * 2. Allowing independent syncs (LinkedIn messages) to run in parallel
 * 3. Providing preemptive token refresh to avoid mid-sync auth failures
 * 4. Comprehensive logging for debugging sync issues
 *
 * Architecture:
 * - Contacts sync and iMessage sync share contactHandles table → must be serialized
 * - LinkedIn sync uses separate linkedin_url handles → can run in parallel
 * - Token refresh is centralized and preemptive
 */

import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export type SyncOperation =
  | 'contacts'      // macOS Contacts.app sync
  | 'imessage'      // iMessage messages sync
  | 'linkedin'      // LinkedIn messages sync (independent)
  | 'linkedin-contacts'; // LinkedIn contacts sync

export type SyncPriority = 'high' | 'normal' | 'low';

interface QueuedSync {
  operation: SyncOperation;
  priority: SyncPriority;
  execute: () => Promise<void>;
  resolve: (value: void) => void;
  reject: (error: Error) => void;
  queuedAt: number;
}

export interface SyncCoordinatorOptions {
  /** Function to get auth token - should handle refresh internally */
  getAuthToken: (forceRefresh?: boolean) => Promise<string | null>;
  /** Called when auth is invalid and cannot be refreshed */
  onAuthInvalid?: () => void;
  /** Token TTL in seconds (default: 3600 for WorkOS) */
  tokenTtlSeconds?: number;
  /** Refresh token when this fraction of TTL elapsed (default: 0.8) */
  refreshThreshold?: number;
}

export interface SyncLog {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  operation: SyncOperation | 'coordinator';
  message: string;
  data?: Record<string, unknown>;
}

// ============================================================================
// SyncCoordinator
// ============================================================================

/**
 * Coordinates all sync operations to prevent race conditions.
 *
 * Key behaviors:
 * - Contacts and iMessage syncs are serialized (they share contactHandles)
 * - LinkedIn sync runs independently (uses linkedin_url handles)
 * - Preemptive token refresh before sync starts
 * - Detailed logging for debugging
 */
export class SyncCoordinator extends EventEmitter {
  // Mutex for serialized operations (contacts, imessage)
  private serializedMutex: Promise<void> = Promise.resolve();
  private serializedQueue: QueuedSync[] = [];
  private isSerializedRunning = false;

  // Independent sync tracking
  private linkedInRunning = false;

  // Auth state
  private options: SyncCoordinatorOptions;
  private lastTokenRefreshAt: number = 0;
  private cachedToken: string | null = null;

  // Logging
  private logs: SyncLog[] = [];
  private maxLogs = 500;

  constructor(options: SyncCoordinatorOptions) {
    super();
    this.options = {
      tokenTtlSeconds: 3600,
      refreshThreshold: 0.8,
      ...options,
    };
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Schedule a contacts sync. Serialized with iMessage sync.
   * Higher priority than iMessage - contacts should sync first.
   */
  async scheduleContactsSync(execute: () => Promise<void>): Promise<void> {
    return this.queueSerializedSync('contacts', 'high', execute);
  }

  /**
   * Schedule an iMessage sync. Serialized with contacts sync.
   */
  async scheduleImessageSync(execute: () => Promise<void>): Promise<void> {
    return this.queueSerializedSync('imessage', 'normal', execute);
  }

  /**
   * Schedule LinkedIn messages sync. Runs independently.
   */
  async scheduleLinkedInSync(execute: () => Promise<void>): Promise<void> {
    if (this.linkedInRunning) {
      this.log('info', 'linkedin', 'LinkedIn sync already running, skipping');
      return;
    }

    this.linkedInRunning = true;
    this.log('info', 'linkedin', 'Starting LinkedIn sync');

    try {
      await this.ensureValidToken();
      await execute();
      this.log('info', 'linkedin', 'LinkedIn sync completed');
    } catch (error) {
      this.log('error', 'linkedin', 'LinkedIn sync failed', { error: String(error) });
      throw error;
    } finally {
      this.linkedInRunning = false;
    }
  }

  /**
   * Schedule LinkedIn contacts sync. Serialized with iMessage/contacts.
   */
  async scheduleLinkedInContactsSync(execute: () => Promise<void>): Promise<void> {
    return this.queueSerializedSync('linkedin-contacts', 'normal', execute);
  }

  /**
   * Get a valid auth token, refreshing preemptively if needed.
   */
  async getValidToken(): Promise<string | null> {
    return this.ensureValidToken();
  }

  /**
   * Check if a sync operation is currently running.
   */
  isRunning(operation: SyncOperation): boolean {
    if (operation === 'linkedin') {
      return this.linkedInRunning;
    }
    return this.isSerializedRunning &&
      this.serializedQueue.some(q => q.operation === operation);
  }

  /**
   * Get current sync status.
   */
  getStatus(): {
    serializedRunning: boolean;
    serializedQueueLength: number;
    linkedInRunning: boolean;
    lastTokenRefresh: number;
    recentLogs: SyncLog[];
  } {
    return {
      serializedRunning: this.isSerializedRunning,
      serializedQueueLength: this.serializedQueue.length,
      linkedInRunning: this.linkedInRunning,
      lastTokenRefresh: this.lastTokenRefreshAt,
      recentLogs: this.logs.slice(-20),
    };
  }

  /**
   * Get all logs (for debugging).
   */
  getLogs(): SyncLog[] {
    return [...this.logs];
  }

  /**
   * Clear logs.
   */
  clearLogs(): void {
    this.logs = [];
  }

  // ============================================================================
  // Private: Serialized Queue
  // ============================================================================

  private async queueSerializedSync(
    operation: SyncOperation,
    priority: SyncPriority,
    execute: () => Promise<void>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const queuedSync: QueuedSync = {
        operation,
        priority,
        execute,
        resolve,
        reject,
        queuedAt: Date.now(),
      };

      // Insert in priority order (high > normal > low)
      const priorityOrder = { high: 0, normal: 1, low: 2 };
      const insertIndex = this.serializedQueue.findIndex(
        (q) => priorityOrder[q.priority] > priorityOrder[priority]
      );

      if (insertIndex === -1) {
        this.serializedQueue.push(queuedSync);
      } else {
        this.serializedQueue.splice(insertIndex, 0, queuedSync);
      }

      this.log('info', 'coordinator', `Queued ${operation} sync`, {
        priority,
        queueLength: this.serializedQueue.length,
      });

      this.processSerializedQueue();
    });
  }

  private async processSerializedQueue(): Promise<void> {
    if (this.isSerializedRunning || this.serializedQueue.length === 0) {
      return;
    }

    this.isSerializedRunning = true;
    const sync = this.serializedQueue.shift()!;
    const waitTime = Date.now() - sync.queuedAt;

    this.log('info', sync.operation, `Starting sync (waited ${waitTime}ms in queue)`);

    try {
      // Ensure valid token before starting
      await this.ensureValidToken();

      const startTime = Date.now();
      await sync.execute();
      const duration = Date.now() - startTime;

      this.log('info', sync.operation, `Sync completed in ${duration}ms`);
      sync.resolve();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log('error', sync.operation, `Sync failed: ${errorMessage}`, {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });
      sync.reject(error instanceof Error ? error : new Error(errorMessage));
    } finally {
      this.isSerializedRunning = false;
      // Process next in queue
      this.processSerializedQueue();
    }
  }

  // ============================================================================
  // Private: Auth Token Management
  // ============================================================================

  private async ensureValidToken(): Promise<string | null> {
    const now = Date.now();
    const ttlMs = (this.options.tokenTtlSeconds ?? 3600) * 1000;
    const refreshThreshold = this.options.refreshThreshold ?? 0.8;
    const refreshAfterMs = ttlMs * refreshThreshold;

    // Check if we need to refresh
    const timeSinceRefresh = now - this.lastTokenRefreshAt;
    const needsRefresh =
      !this.cachedToken ||
      timeSinceRefresh > refreshAfterMs;

    if (needsRefresh) {
      this.log('debug', 'coordinator', 'Refreshing auth token', {
        timeSinceRefresh,
        refreshAfterMs,
        hadCachedToken: !!this.cachedToken,
      });

      const forceRefresh = !this.cachedToken || timeSinceRefresh > ttlMs;
      const token = await this.options.getAuthToken(forceRefresh);

      if (!token) {
        this.log('error', 'coordinator', 'Token refresh failed - no token returned');
        this.options.onAuthInvalid?.();
        return null;
      }

      this.cachedToken = token;
      this.lastTokenRefreshAt = now;
      this.log('info', 'coordinator', 'Auth token refreshed successfully');
    }

    return this.cachedToken;
  }

  // ============================================================================
  // Private: Logging
  // ============================================================================

  private log(
    level: SyncLog['level'],
    operation: SyncLog['operation'],
    message: string,
    data?: Record<string, unknown>
  ): void {
    const log: SyncLog = {
      timestamp: Date.now(),
      level,
      operation,
      message,
      data,
    };

    this.logs.push(log);

    // Trim old logs
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }

    // Console output with prefix
    const prefix = `[SyncCoordinator:${operation}]`;
    const fullMessage = data
      ? `${prefix} ${message} ${JSON.stringify(data)}`
      : `${prefix} ${message}`;

    switch (level) {
      case 'error':
        console.error(fullMessage);
        break;
      case 'warn':
        console.warn(fullMessage);
        break;
      case 'info':
        console.log(fullMessage);
        break;
      case 'debug':
        // Only log debug in development
        if (process.env.NODE_ENV === 'development' || process.env.DEBUG_SYNC) {
          console.log(fullMessage);
        }
        break;
    }

    // Emit for external listeners
    this.emit('log', log);
  }
}

// ============================================================================
// Singleton
// ============================================================================

let syncCoordinator: SyncCoordinator | null = null;

/**
 * Get the singleton SyncCoordinator instance.
 * Must be initialized with options on first call.
 */
export function getSyncCoordinator(options?: SyncCoordinatorOptions): SyncCoordinator {
  if (!syncCoordinator) {
    if (!options) {
      throw new Error('SyncCoordinator not initialized - must provide options on first call');
    }
    syncCoordinator = new SyncCoordinator(options);
  }
  return syncCoordinator;
}

/**
 * Reset the singleton (for testing).
 */
export function resetSyncCoordinator(): void {
  syncCoordinator = null;
}
