/**
 * SyncCoordinator - Central orchestrator for all sync operations.
 *
 * Architecture:
 * - Contacts sync runs first on startup (before iMessage sync starts)
 * - This ensures contactHandles exist for known contacts, preventing duplicates
 * - After initial sync, contacts watcher handles incremental changes
 * - LinkedIn/Slack syncs are independent (different handle types)
 * - Provides centralized logging and status tracking
 */

import { EventEmitter } from 'events'

// ============================================================================
// Types
// ============================================================================

export type SyncOperation =
  | 'contacts' // macOS Contacts.app sync
  | 'imessage' // iMessage messages sync
  | 'linkedin' // LinkedIn messages sync
  | 'slack' // Slack messages sync

export interface SyncCoordinatorOptions {
  /** Function to get auth token - should handle refresh internally */
  getAuthToken: (forceRefresh?: boolean) => Promise<string | null>
  /** Called when auth is invalid and cannot be refreshed */
  onAuthInvalid?: () => void
}

export interface SyncLog {
  timestamp: number
  level: 'debug' | 'info' | 'warn' | 'error'
  operation: SyncOperation | 'coordinator'
  message: string
  data?: Record<string, unknown>
}

// ============================================================================
// SyncCoordinator
// ============================================================================

/**
 * Coordinates all sync operations.
 *
 * Key behaviors:
 * - Contacts sync runs first on startup to populate contactHandles
 * - Prevents duplicate operations (same operation can't run concurrently)
 * - Lock groups prevent race conditions on shared resources (e.g., contactHandles)
 * - Detailed logging for debugging
 */
export class SyncCoordinator extends EventEmitter {
  // Running sync tracking
  private runningOperations: Set<SyncOperation> = new Set()

  // Lock groups: operations that write to shared resources must not run concurrently
  // All sync operations write to contactHandles table via getOrCreateContact
  private static readonly CONTACT_WRITERS = new Set<SyncOperation>([
    'contacts',
    'imessage',
    'linkedin',
    'slack',
  ])
  private contactWriteLockHolder: SyncOperation | null = null

  // Auth state
  private options: SyncCoordinatorOptions

  // Logging
  private logs: SyncLog[] = []
  private maxLogs = 500

  constructor(options: SyncCoordinatorOptions) {
    super()
    this.options = options
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Execute a sync operation with logging and token refresh.
   * Skips if the same operation is already running, or if a conflicting
   * operation holds the shared resource lock.
   */
  async executeSync(
    operation: SyncOperation,
    execute: () => Promise<void>
  ): Promise<void> {
    // Check if same operation is already running
    if (this.runningOperations.has(operation)) {
      this.log('info', operation, `${operation} sync already running, skipping`)
      return
    }

    // Check if a conflicting operation holds the contact write lock
    const writesToContacts = SyncCoordinator.CONTACT_WRITERS.has(operation)
    if (writesToContacts && this.contactWriteLockHolder !== null) {
      this.log(
        'info',
        operation,
        `Skipped: ${this.contactWriteLockHolder} holds contact write lock`
      )
      return
    }

    // Acquire locks
    this.runningOperations.add(operation)
    if (writesToContacts) {
      this.contactWriteLockHolder = operation
    }
    this.log('info', operation, `Starting ${operation} sync`)

    try {
      await this.ensureValidToken()
      const startTime = Date.now()
      await execute()
      const duration = Date.now() - startTime
      this.log('info', operation, `${operation} sync completed in ${duration}ms`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.log('error', operation, `${operation} sync failed: ${errorMessage}`, {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      })
      throw error
    } finally {
      this.runningOperations.delete(operation)
      if (writesToContacts) {
        this.contactWriteLockHolder = null
      }
    }
  }

  /**
   * Convenience methods for specific sync types.
   */
  async scheduleContactsSync(execute: () => Promise<void>): Promise<void> {
    return this.executeSync('contacts', execute)
  }

  async scheduleImessageSync(execute: () => Promise<void>): Promise<void> {
    return this.executeSync('imessage', execute)
  }

  async scheduleLinkedInSync(execute: () => Promise<void>): Promise<void> {
    return this.executeSync('linkedin', execute)
  }

  async scheduleSlackSync(execute: () => Promise<void>): Promise<void> {
    return this.executeSync('slack', execute)
  }

  /**
   * Get a valid auth token (delegates to auth-manager for refresh logic).
   */
  async getValidToken(): Promise<string | null> {
    return this.ensureValidToken()
  }

  /**
   * Check if a sync operation is currently running.
   */
  isRunning(operation: SyncOperation): boolean {
    return this.runningOperations.has(operation)
  }

  /**
   * Check if an operation would be blocked by the contact write lock.
   */
  isBlockedByContactLock(operation: SyncOperation): boolean {
    if (!SyncCoordinator.CONTACT_WRITERS.has(operation)) {
      return false
    }
    const lockHolder = this.contactWriteLockHolder
    return lockHolder !== null && lockHolder !== operation
  }

  /**
   * Get current sync status.
   */
  getStatus(): {
    runningOperations: SyncOperation[]
    contactWriteLockHolder: SyncOperation | null
    recentLogs: SyncLog[]
  } {
    return {
      runningOperations: Array.from(this.runningOperations),
      contactWriteLockHolder: this.contactWriteLockHolder,
      recentLogs: this.logs.slice(-20),
    }
  }

  /**
   * Get all logs (for debugging).
   */
  getLogs(): SyncLog[] {
    return [...this.logs]
  }

  /**
   * Clear logs.
   */
  clearLogs(): void {
    this.logs = []
  }

  // ============================================================================
  // Private: Auth Token Management
  // ============================================================================

  private async ensureValidToken(): Promise<string | null> {
    const token = await this.options.getAuthToken()

    if (!token) {
      this.log('error', 'coordinator', 'No valid auth token available')
      this.options.onAuthInvalid?.()
      return null
    }

    return token
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
    }

    this.logs.push(log)

    // Trim old logs
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs)
    }

    // Console output with prefix
    const prefix = `[SyncCoordinator:${operation}]`
    const fullMessage = data
      ? `${prefix} ${message} ${JSON.stringify(data)}`
      : `${prefix} ${message}`

    switch (level) {
      case 'error':
        console.error(fullMessage)
        break
      case 'warn':
        console.warn(fullMessage)
        break
      case 'info':
        console.log(fullMessage)
        break
      case 'debug':
        if (process.env.NODE_ENV === 'development' || process.env.DEBUG_SYNC) {
          console.log(fullMessage)
        }
    }

    this.emit('log', log)
  }
}

// ============================================================================
// Singleton
// ============================================================================

let syncCoordinator: SyncCoordinator | null = null

/**
 * Get the singleton SyncCoordinator instance.
 * Must be initialized with options on first call.
 */
export function getSyncCoordinator(options?: SyncCoordinatorOptions): SyncCoordinator {
  if (!syncCoordinator) {
    if (!options) {
      throw new Error('SyncCoordinator not initialized - must provide options on first call')
    }
    syncCoordinator = new SyncCoordinator(options)
  }
  return syncCoordinator
}

/**
 * Reset the singleton (for testing).
 */
export function resetSyncCoordinator(): void {
  syncCoordinator = null
}
