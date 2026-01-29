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
import { orchestratorMachine, type OrchestratorEvent } from './machines/orchestrator'
import { type SyncActorInput } from './machines/sync-actor'
import {
  type SyncTypeId,
  type SyncFunction,
  type SyncProgress,
  type SyncEngineStatus,
  type SyncPhase,
  SYNC_CONFIGS,
  getSyncKey,
} from './types'

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
  private timerIntervals: Map<string, NodeJS.Timeout> = new Map()

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
    this.orchestrator.subscribe((snapshot) => {
      this.reportProgress(snapshot)
    })

    console.log('[SyncEngine] Initialized')
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

    // Clear any interval timer
    const timer = this.timerIntervals.get(key)
    if (timer) {
      clearInterval(timer)
      this.timerIntervals.delete(key)
    }

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
   */
  syncNow(): void {
    if (!this.orchestrator || !this.isStarted) {
      console.warn('[SyncEngine] Not running, cannot trigger sync')
      return
    }

    this.orchestrator.send({ type: 'SYNC_NOW' })
    console.log('[SyncEngine] Triggered immediate sync')
  }

  // ============================================================================
  // Timer Management
  // ============================================================================

  private startTimers(): void {
    for (const [key, syncFn] of this.syncFunctions) {
      const [syncType] = key.split(':') as [SyncTypeId]
      const config = SYNC_CONFIGS[syncType]

      // Set up interval timer
      const timer = setInterval(() => {
        if (this.isStarted) {
          this.orchestrator?.send({ type: 'SYNC_NOW' })
        }
      }, config.defaultIntervalMs)

      this.timerIntervals.set(key, timer)
      console.log(
        `[SyncEngine] Started timer for ${key} (${config.defaultIntervalMs}ms)`
      )
    }
  }

  private stopTimers(): void {
    for (const [key, timer] of this.timerIntervals) {
      clearInterval(timer)
      console.log(`[SyncEngine] Stopped timer for ${key}`)
    }
    this.timerIntervals.clear()
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

    // Aggregate platform results
    const platforms: SyncProgress['platforms'] = {}

    for (const actor of status.actors) {
      switch (actor.syncType) {
        case 'contacts':
          platforms.contacts = {
            synced: actor.totalContactsSynced,
            updated: 0, // Not tracked separately
          }
          break
        case 'imessage':
          platforms.imessage = {
            messages: actor.totalMessagesSynced,
          }
          break
        case 'linkedin':
        case 'linkedin_contacts': {
          const existing = platforms.linkedin ?? { contacts: 0, messages: 0 }
          if (actor.syncType === 'linkedin_contacts') {
            existing.contacts = actor.totalContactsSynced
          } else {
            existing.messages = actor.totalMessagesSynced
          }
          platforms.linkedin = existing
          break
        }
        case 'slack': {
          const existing = platforms.slack ?? { messages: 0, workspaces: 0 }
          existing.messages += actor.totalMessagesSynced
          existing.workspaces += 1
          platforms.slack = existing
          break
        }
      }
    }

    // Determine current platform being synced
    let currentPlatform: SyncTypeId | undefined
    for (const actor of status.actors) {
      if (actor.state === 'syncing') {
        currentPlatform = actor.syncType
        break
      }
    }

    return {
      status: status.isRunning ? 'syncing' : status.error ? 'error' : 'idle',
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

  private reportProgress(snapshot: ReturnType<OrchestratorRef['getSnapshot']>): void {
    if (!this.progressCallback) return

    const progress = this.getProgress()
    this.progressCallback(progress)
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
