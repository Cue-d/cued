/**
 * FSEvents-based triggers for sync.
 *
 * Watches filesystem for changes that should trigger syncs:
 * - iMessage: ~/Library/Messages/chat.db
 * - Contacts: Uses existing Swift CLI watcher
 */

import { watch, type FSWatcher } from 'chokidar'
import { homedir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'

// ============================================================================
// Types
// ============================================================================

export interface FSEventsTriggerEvents {
  change: [path: string]
  error: [error: Error]
  ready: []
}

// ============================================================================
// iMessage Watcher
// ============================================================================

const IMESSAGE_DB_PATH = join(homedir(), 'Library/Messages/chat.db')

/**
 * Watches the iMessage chat.db for changes.
 * Emits 'change' event when the database is modified.
 */
export class IMessageWatcher extends EventEmitter<FSEventsTriggerEvents> {
  private watcher: FSWatcher | null = null
  private isRunning = false
  private debounceTimer: NodeJS.Timeout | null = null
  private readonly debounceMs: number

  constructor(options: { debounceMs?: number } = {}) {
    super()
    this.debounceMs = options.debounceMs ?? 500
  }

  /**
   * Start watching the iMessage database.
   */
  start(): void {
    if (this.isRunning) return
    this.isRunning = true

    try {
      this.watcher = watch(IMESSAGE_DB_PATH, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 300,
          pollInterval: 100,
        },
      })

      this.watcher.on('change', (path) => {
        this.handleChange(path)
      })

      this.watcher.on('error', (error) => {
        const err = error instanceof Error ? error : new Error(String(error))
        console.error('[IMessageWatcher] Error:', err.message)
        this.emit('error', err)
      })

      this.watcher.on('ready', () => {
        console.log('[IMessageWatcher] Watching for changes:', IMESSAGE_DB_PATH)
        this.emit('ready')
      })
    } catch (error) {
      console.error('[IMessageWatcher] Failed to start:', error)
      this.emit('error', error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Stop watching.
   */
  stop(): void {
    if (!this.isRunning) return
    this.isRunning = false

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }

    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }

    console.log('[IMessageWatcher] Stopped')
  }

  /**
   * Check if watching.
   */
  isWatching(): boolean {
    return this.isRunning
  }

  private handleChange(path: string): void {
    // Debounce rapid changes
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      console.log('[IMessageWatcher] Database changed')
      this.emit('change', path)
    }, this.debounceMs)
  }
}

// ============================================================================
// Singleton
// ============================================================================

let imessageWatcherInstance: IMessageWatcher | null = null

/**
 * Get the singleton IMessageWatcher instance.
 */
export function getIMessageWatcher(): IMessageWatcher {
  if (!imessageWatcherInstance) {
    imessageWatcherInstance = new IMessageWatcher()
  }
  return imessageWatcherInstance
}
