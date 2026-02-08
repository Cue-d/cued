/**
 * XState Sync Engine
 *
 * Main entry point for the XState-based sync system.
 * Manages the orchestrator and provides the public API for:
 * - Starting/stopping sync
 * - Registering platform sync functions
 * - Progress reporting
 * - DevTools integration
 */

import { createActor, type ActorRefFrom } from 'xstate'
import { createBrowserInspector } from '@statelyai/inspect'
import { orchestratorMachine } from './machines/orchestrator.js'
import { type SyncActorInput } from './machines/sync-actor.js'
import {
  type SyncTypeId,
  type SyncFunction,
  type SyncProgress,
  type SyncEngineStatus,
  type SyncPhase,
  SYNC_CONFIGS,
  getSyncKey,
} from './types.js'

// ============================================================================
// Types
// ============================================================================

type OrchestratorRef = ActorRefFrom<typeof orchestratorMachine>

export interface SyncEngineOptions {
  /** Enable XState DevTools inspector */
  enableInspector?: boolean
  /** Progress callback */
  onProgress?: (progress: SyncProgress) => void
}

// ============================================================================
// Sync Engine
// ============================================================================

/**
 * Singleton sync engine that coordinates all platform syncs.
 */
export class SyncEngine {
  private orchestrator: OrchestratorRef | null = null
  private syncFunctions: Map<string, SyncFunction> = new Map()
  private progressCallback?: (progress: SyncProgress) => void
  private inspector: ReturnType<typeof createBrowserInspector> | null = null
  private isStarted = false
  private syncTimer: NodeJS.Timeout | null = null

  constructor(private options: SyncEngineOptions = {}) {
    this.progressCallback = options.onProgress
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  /**
   * Initialize the sync engine.
   * Must be called before registering sync functions or starting.
   */
  initialize(): void {
    if (this.orchestrator) {
      console.warn('[SyncEngine] Already initialized')
      return
    }

    // Set up inspector in dev mode
    if (this.options.enableInspector && process.env.NODE_ENV === 'development') {
      try {
        this.inspector = createBrowserInspector()
        console.log('[SyncEngine] XState inspector enabled')
      } catch (e) {
        console.warn('[SyncEngine] Failed to create inspector:', e)
      }
    }

    // Create orchestrator actor
    this.orchestrator = createActor(orchestratorMachine, {
      inspect: this.inspector?.inspect,
    })

    // Subscribe to state changes for progress reporting
    this.orchestrator.subscribe(() => {
      this.reportProgress()
    })

    console.log('[SyncEngine] Initialized')
  }

  /**
   * Check if the engine has been initialized.
   */
  isInitialized(): boolean {
    return this.orchestrator !== null
  }

  /**
   * Register a sync function for a platform.
   */
  registerSync(
    syncType: SyncTypeId,
    syncFn: SyncFunction,
    workspaceId?: string
  ): void {
    if (!this.orchestrator) {
      throw new Error('[SyncEngine] Not initialized. Call initialize() first.')
    }

    const key = getSyncKey(syncType, workspaceId)

    // Store sync function
    this.syncFunctions.set(key, syncFn)

    // Create actor config
    const config: SyncActorInput = {
      syncType,
      workspaceId,
      syncFn,
    }

    // Register with orchestrator
    this.orchestrator.send({
      type: 'REGISTER_ACTOR',
      config,
    })

    console.log(`[SyncEngine] Registered sync: ${key}`)
  }

  /**
   * Unregister a sync function.
   */
  unregisterSync(syncType: SyncTypeId, workspaceId?: string): void {
    if (!this.orchestrator) return

    const key = getSyncKey(syncType, workspaceId)
    this.syncFunctions.delete(key)

    this.orchestrator.send({
      type: 'UNREGISTER_ACTOR',
      actorId: key,
    })

    console.log(`[SyncEngine] Unregistered sync: ${key}`)
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Start the sync engine and run initial sync.
   */
  start(): void {
    if (!this.orchestrator) {
      throw new Error('[SyncEngine] Not initialized. Call initialize() first.')
    }

    if (this.isStarted) {
      console.warn('[SyncEngine] Already started')
      return
    }

    this.orchestrator.start()
    this.orchestrator.send({ type: 'START' })
    this.isStarted = true

    // Start interval timers for each sync type
    this.startTimers()

    console.log('[SyncEngine] Started')
  }

  /**
   * Stop the sync engine.
   */
  stop(): void {
    if (!this.orchestrator || !this.isStarted) return

    // Stop all timers
    this.stopTimers()

    this.orchestrator.send({ type: 'STOP' })
    this.orchestrator.stop()
    this.isStarted = false

    console.log('[SyncEngine] Stopped')
  }

  /**
   * Trigger an immediate sync cycle.
   * @returns true if sync was triggered, false if engine not running
   */
  syncNow(): boolean {
    if (!this.orchestrator || !this.isStarted) {
      console.warn('[SyncEngine] Not running, cannot trigger sync')
      return false
    }

    this.orchestrator.send({ type: 'SYNC_NOW' })
    return true
  }

  // ============================================================================
  // Timer Management
  // ============================================================================

  private startTimers(): void {
    // Find minimum interval from all registered sync types
    let minIntervalMs = Infinity
    for (const key of this.syncFunctions.keys()) {
      const [syncType] = key.split(':') as [SyncTypeId]
      const config = SYNC_CONFIGS[syncType]
      minIntervalMs = Math.min(minIntervalMs, config.defaultIntervalMs)
    }

    // Default to 30 seconds if no syncs registered
    if (minIntervalMs === Infinity) {
      minIntervalMs = 30 * 1000
    }

    // Single timer triggers full sync cycle
    this.syncTimer = setInterval(() => {
      if (this.isStarted) {
        this.orchestrator?.send({ type: 'SYNC_NOW' })
      }
    }, minIntervalMs)

    console.log(`[SyncEngine] Started sync timer (${minIntervalMs}ms interval)`)
  }

  private stopTimers(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer)
      this.syncTimer = null
      console.log('[SyncEngine] Stopped sync timer')
    }
  }

  // ============================================================================
  // Status & Progress
  // ============================================================================

  /**
   * Get current engine status.
   */
  getStatus(): SyncEngineStatus {
    if (!this.orchestrator) {
      return {
        isRunning: false,
        currentPhase: null,
        lastFullSyncAt: null,
        actors: [],
        error: null,
      }
    }

    const snapshot = this.orchestrator.getSnapshot()
    const context = snapshot.context
    const stateValue = snapshot.value

    // Determine current phase from state
    let currentPhase: SyncPhase | null = null
    if (typeof stateValue === 'object' && 'running' in stateValue) {
      const runningState = (stateValue as { running: string }).running
      if (runningState === 'contactsPhase') {
        currentPhase = 'contacts'
      } else if (runningState === 'contactsDependentPhase') {
        currentPhase = 'contacts_dependent'
      } else if (runningState === 'messagesPhase') {
        currentPhase = 'messages'
      }
    }

    // Get actor statuses
    const actors = Array.from(context.actors.entries()).map(([key, actor]) => {
      const actorSnapshot = actor.getSnapshot()
      const actorContext = actorSnapshot.context
      const [syncType] = key.split(':') as [SyncTypeId]

      return {
        syncType,
        workspaceId: actorContext.workspaceId,
        state: actorSnapshot.value as 'idle' | 'syncing' | 'backoff' | 'stopped',
        lastSyncAt: actorContext.lastSyncAt,
        lastError: actorContext.lastError,
        retryCount: actorContext.retryCount,
        totalMessagesSynced: actorContext.totalMessagesSynced,
        totalContactsSynced: actorContext.totalContactsSynced,
      }
    })

    return {
      isRunning: context.isRunning,
      currentPhase,
      lastFullSyncAt: context.lastFullSyncAt,
      actors,
      error: context.lastError,
    }
  }

  /**
   * Get progress in format compatible with existing UnifiedSyncProgress.
   */
  getProgress(): SyncProgress {
    const status = this.getStatus()
    const platforms: SyncProgress['platforms'] = {}

    for (const actor of status.actors) {
      switch (actor.syncType) {
        case 'contacts':
          platforms.contacts = { synced: actor.totalContactsSynced, updated: 0 }
          break

        case 'imessage':
          platforms.imessage = { messages: actor.totalMessagesSynced }
          break

        case 'linkedin':
          platforms.linkedin = {
            contacts: platforms.linkedin?.contacts ?? 0,
            messages: actor.totalMessagesSynced,
          }
          break

        case 'linkedin_contacts':
          platforms.linkedin = {
            contacts: actor.totalContactsSynced,
            messages: platforms.linkedin?.messages ?? 0,
          }
          break

        case 'twitter':
          platforms.twitter = {
            contacts: platforms.twitter?.contacts ?? 0,
            messages: actor.totalMessagesSynced,
          }
          break

        case 'twitter_contacts':
          platforms.twitter = {
            contacts: actor.totalContactsSynced,
            messages: platforms.twitter?.messages ?? 0,
          }
          break

        case 'slack':
          platforms.slack = {
            messages: (platforms.slack?.messages ?? 0) + actor.totalMessagesSynced,
            workspaces: (platforms.slack?.workspaces ?? 0) + 1,
          }
          break

        case 'signal':
          platforms.signal = {
            contacts: platforms.signal?.contacts ?? 0,
            messages: actor.totalMessagesSynced,
          }
          break

        case 'signal_contacts':
          platforms.signal = {
            contacts: actor.totalContactsSynced,
            messages: platforms.signal?.messages ?? 0,
          }
          break
      }
    }

    const currentPlatform = status.actors.find((a) => a.state === 'syncing')?.syncType

    let progressStatus: SyncProgress['status'] = 'idle'
    if (status.isRunning) {
      progressStatus = 'syncing'
    } else if (status.error) {
      progressStatus = 'error'
    }

    return {
      status: progressStatus,
      currentPlatform,
      lastSyncAt: status.lastFullSyncAt ?? undefined,
      platforms,
      error: status.error ?? undefined,
    }
  }

  /**
   * Set progress callback.
   */
  setProgressCallback(callback: (progress: SyncProgress) => void): void {
    this.progressCallback = callback
  }

  private reportProgress(): void {
    if (!this.progressCallback) return

    try {
      this.progressCallback(this.getProgress())
    } catch (error) {
      console.error('[SyncEngine] Progress callback threw an error:', error)
    }
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Destroy the engine and clean up resources.
   */
  destroy(): void {
    this.stop()
    this.orchestrator = null
    this.syncFunctions.clear()
    this.inspector = null
    console.log('[SyncEngine] Destroyed')
  }
}

// ============================================================================
// Singleton
// ============================================================================

let syncEngineInstance: SyncEngine | null = null

/**
 * Get the singleton SyncEngine instance.
 */
export function getSyncEngine(options?: SyncEngineOptions): SyncEngine {
  if (!syncEngineInstance) {
    syncEngineInstance = new SyncEngine(options)
  }
  return syncEngineInstance
}

/**
 * Reset the singleton for testing.
 */
export function resetSyncEngine(): void {
  if (syncEngineInstance) {
    syncEngineInstance.destroy()
    syncEngineInstance = null
  }
}
