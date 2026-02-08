/**
 * Signal sync manager.
 *
 * Runs a persistent signal-cli jsonRpc daemon for real-time message delivery.
 * Falls back to polling via runSync() as a safety-net catch-up.
 */

import { ConvexHttpClient } from 'convex/browser'
import { api } from '@cued/convex'
import { withAuthRetry } from '../../auth/auth-utils'
import { SignalClient, type SignalReceivedMessage } from './client'
import { SignalDaemon } from './daemon'
import {
  type SignalStoredCredentials,
  loadSignalCredentials,
} from './auth'
import {
  createConvexClient,
  loadCursor,
  saveCursor,
  createAuthRetryOptions,
  setConvexAuth,
} from '../../sync/cursor'
import { createSyncGuard } from '../../sync/guard'

const POLL_INTERVAL_MS = 15_000
const MESSAGE_BATCH_MAX = 50
const MESSAGE_BATCH_DEBOUNCE_MS = 2_000

interface SignalCursorState {
  lastSyncAt: number
  lastMessageTimestamp: number
}

export interface SignalSyncProgress {
  status: 'idle' | 'syncing' | 'error'
  lastSyncAt?: number
  totalMessagesSynced: number
  error?: string
}

export interface SignalSyncManagerOptions {
  onProgress?: (progress: SignalSyncProgress) => void
}

export class SignalSyncManager {
  private client: SignalClient | null = null
  private credentials: SignalStoredCredentials | null = null
  private convexClient: ConvexHttpClient
  private pollIntervalId: NodeJS.Timeout | null = null
  private syncGuard = createSyncGuard()
  private lastMessageTimestamp = 0
  private hasInitialized = false
  private progress: SignalSyncProgress = {
    status: 'idle',
    totalMessagesSynced: 0,
  }
  private options: SignalSyncManagerOptions

  // Daemon fields
  private daemon: SignalDaemon | null = null
  private messageBuffer: SignalReceivedMessage[] = []
  private flushTimer: NodeJS.Timeout | null = null

  constructor(options: SignalSyncManagerOptions = {}) {
    this.options = options
    this.convexClient = createConvexClient()
  }

  getProgress(): SignalSyncProgress {
    return { ...this.progress }
  }

  getClient(): SignalClient | null {
    return this.client
  }

  getAccount(): string | null {
    return this.credentials?.account ?? null
  }

  isAuthenticated(): boolean {
    return this.client !== null
  }

  setProgressCallback(onProgress: (progress: SignalSyncProgress) => void): void {
    this.options.onProgress = onProgress
  }

  private updateProgress(partial: Partial<SignalSyncProgress>): void {
    this.progress = { ...this.progress, ...partial }
    this.options.onProgress?.(this.progress)
  }

  private async ensureClient(): Promise<boolean> {
    if (this.client) {
      return true
    }

    this.credentials = loadSignalCredentials()
    if (!this.credentials) {
      this.updateProgress({
        status: 'error',
        error: 'Signal is not configured (missing SIGNAL_ACCOUNT)',
      })
      return false
    }

    const client = new SignalClient({
      account: this.credentials.account,
      cliPath: this.credentials.cliPath,
    })

    if (!(await client.isAvailable())) {
      this.updateProgress({
        status: 'error',
        error: `signal-cli not available (${this.credentials.cliPath ?? 'signal-cli'})`,
      })
      return false
    }

    this.client = client
    return true
  }

  private async initializeCursorFromCloud(): Promise<void> {
    const cursor = await loadCursor<SignalCursorState>(this.convexClient, 'signal')
    if (!cursor) return

    this.lastMessageTimestamp = cursor.cursorData.lastMessageTimestamp ?? 0
    this.updateProgress({
      lastSyncAt: cursor.cursorData.lastSyncAt ?? cursor.lastSyncAt,
    })
  }

  async initialize(): Promise<boolean> {
    if (this.hasInitialized && this.client) {
      const token = await setConvexAuth(this.convexClient)
      if (!token) {
        this.updateProgress({
          status: 'error',
          error: 'Not authenticated',
        })
        return false
      }
      return true
    }

    const ready = await this.ensureClient()
    if (!ready) {
      return false
    }

    const token = await setConvexAuth(this.convexClient)
    if (!token) {
      this.updateProgress({
        status: 'error',
        error: 'Not authenticated',
      })
      return false
    }

    await this.initializeCursorFromCloud()
    this.hasInitialized = true

    // Start the daemon on first successful init (startDaemon no-ops if already running)
    this.startDaemon()

    return true
  }

  async start(): Promise<void> {
    if (this.pollIntervalId) return

    const initialized = await this.initialize()
    if (!initialized) {
      return
    }

    // Run an initial catch-up sync, then poll as safety net
    await this.runSync()
    this.pollIntervalId = setInterval(() => {
      this.runSync().catch(() => {
        // Error already logged and progress updated in runSync
      })
    }, POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId)
      this.pollIntervalId = null
    }
    this.stopDaemon()
    this.updateProgress({ status: 'idle' })
  }

  async disconnect(): Promise<void> {
    this.stop()
    this.client = null
    this.credentials = null
    this.lastMessageTimestamp = 0
    this.hasInitialized = false
  }

  // ---------------------------------------------------------------------------
  // Daemon lifecycle
  // ---------------------------------------------------------------------------

  private startDaemon(): void {
    if (this.daemon || !this.client || !this.credentials) return

    const daemon = new SignalDaemon(
      this.credentials.account,
      this.client.getCliPath(),
      {
        onMessage: (message) => this.bufferMessage(message),
        onConnected: () => {
          console.log('[SignalSync] Daemon connected')
          // Re-register daemon on client (needed after reconnect)
          this.client?.setDaemon(this.daemon)
        },
        onDisconnected: (error) => {
          console.warn('[SignalSync] Daemon disconnected', error?.message)
          this.client?.setDaemon(null)
        },
      }
    )

    this.daemon = daemon
    this.client.setDaemon(daemon)
    daemon.start()
  }

  private stopDaemon(): void {
    if (this.daemon) {
      this.daemon.stop()
      this.daemon = null
    }
    this.client?.setDaemon(null)
    this.flushBufferNow()
  }

  // ---------------------------------------------------------------------------
  // Message buffering — batch up to MESSAGE_BATCH_MAX or debounce 2s
  // ---------------------------------------------------------------------------

  private bufferMessage(message: SignalReceivedMessage): void {
    this.messageBuffer.push(message)

    if (this.messageBuffer.length >= MESSAGE_BATCH_MAX) {
      this.flushBufferNow()
      return
    }

    // Reset debounce timer
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => this.flushBufferNow(), MESSAGE_BATCH_DEBOUNCE_MS)
  }

  private flushBufferNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    const batch = this.messageBuffer.splice(0)
    if (batch.length === 0) return

    this.flushBatch(batch).catch((err) => {
      console.error('[SignalSync] Daemon batch sync failed, re-queuing messages:', err)
      // Re-queue failed messages at the front so they're retried on next flush
      this.messageBuffer.unshift(...batch)
      this.updateProgress({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    })
  }

  private async flushBatch(messages: SignalReceivedMessage[]): Promise<void> {
    // Ensure auth is fresh before syncing
    await setConvexAuth(this.convexClient)

    const count = await this.syncMessages(messages)

    this.lastMessageTimestamp = Math.max(
      this.lastMessageTimestamp,
      ...messages.map((m) => m.sentAt)
    )

    const syncedAt = Date.now()
    await saveCursor(this.convexClient, 'signal', {
      lastSyncAt: syncedAt,
      lastMessageTimestamp: this.lastMessageTimestamp,
    })

    this.updateProgress({
      status: 'idle',
      lastSyncAt: syncedAt,
      totalMessagesSynced: this.progress.totalMessagesSynced + count,
    })
  }

  // ---------------------------------------------------------------------------
  // Sync messages to Convex
  // ---------------------------------------------------------------------------

  private async syncMessages(messages: SignalReceivedMessage[]): Promise<number> {
    if (messages.length === 0) {
      return 0
    }

    await withAuthRetry(
      () =>
        this.convexClient.mutation((api as any).sync.syncSignalMessages, {
          messages,
        }),
      createAuthRetryOptions(this.convexClient)
    )

    return messages.length
  }

  async syncSentMessage(message: SignalReceivedMessage): Promise<void> {
    if (!(await this.initialize())) {
      return
    }

    await this.syncMessages([message])

    this.lastMessageTimestamp = Math.max(this.lastMessageTimestamp, message.sentAt)
    await saveCursor(this.convexClient, 'signal', {
      lastSyncAt: Date.now(),
      lastMessageTimestamp: this.lastMessageTimestamp,
    })
  }

  async runSync(): Promise<void> {
    if (!this.syncGuard.tryStart()) {
      return
    }

    try {
      if (!(await this.initialize())) {
        return
      }

      this.updateProgress({ status: 'syncing', error: undefined })

      const messages = await this.client!.receiveMessages(1)

      if (messages.length > 0) {
        await this.syncMessages(messages)
        this.lastMessageTimestamp = Math.max(
          this.lastMessageTimestamp,
          ...messages.map((m) => m.sentAt)
        )
      }

      const syncedAt = Date.now()
      await saveCursor(this.convexClient, 'signal', {
        lastSyncAt: syncedAt,
        lastMessageTimestamp: this.lastMessageTimestamp,
      })

      this.updateProgress({
        status: 'idle',
        lastSyncAt: syncedAt,
        totalMessagesSynced:
          this.progress.totalMessagesSynced + messages.length,
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[SignalSync] Error:', errorMessage)
      this.updateProgress({
        status: 'error',
        error: errorMessage,
      })
      throw error
    } finally {
      this.syncGuard.finish()
    }
  }
}

let signalSyncManager: SignalSyncManager | null = null

export function getSignalSyncManager(
  options: SignalSyncManagerOptions = {}
): SignalSyncManager {
  if (!signalSyncManager) {
    signalSyncManager = new SignalSyncManager(options)
  }
  if (options.onProgress) {
    signalSyncManager.setProgressCallback(options.onProgress)
  }
  return signalSyncManager
}
