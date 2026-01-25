/**
 * Shared sync utilities used across all platform sync managers.
 *
 * Provides:
 * - Cursor management (load, save, clear from Convex)
 * - Convex client creation with auth
 * - Progress reporting helper
 */

import { ConvexHttpClient } from 'convex/browser'
import { api } from '@prm/convex'
import { withAuthRetry } from '../auth/auth-utils'
import { electronEnv } from '@prm/env/electron'
import { createAuthRetryOptions, setConvexAuth } from '../auth/auth-manager'

// Re-export centralized auth helpers for convenience
export { createAuthRetryOptions, setConvexAuth }

// ============================================================================
// Types
// ============================================================================

export type SyncPlatform = 'imessage' | 'linkedin' | 'slack' | 'gmail'

export type SyncMode = 'full' | 'incremental'

export interface CursorSaveOptions {
  syncMode?: SyncMode
  fullSyncProgress?: {
    phase: string
    offset: number
  }
}

// ============================================================================
// Convex Client
// ============================================================================

const CONVEX_URL = electronEnv.CONVEX_URL

/**
 * Create a Convex HTTP client.
 */
export function createConvexClient(): ConvexHttpClient {
  return new ConvexHttpClient(CONVEX_URL)
}

// ============================================================================
// Cursor Management
// ============================================================================

/**
 * Load cursor state from Convex syncCursors table.
 * Returns null if no cursor exists.
 */
export async function loadCursor<T>(
  client: ConvexHttpClient,
  platform: SyncPlatform,
  workspaceId?: string
): Promise<{ cursorData: T; lastSyncAt: number } | null> {
  try {
    // @ts-ignore - TS2589: Convex's generated types hit TypeScript's depth limit
    const cursor = await client.query(api.syncCursors.getSyncCursor, {
      platform,
      workspaceId,
    })

    if (cursor?.cursorData) {
      return {
        cursorData: cursor.cursorData as T,
        lastSyncAt: cursor.lastSyncAt ?? 0,
      }
    }
    return null
  } catch (error) {
    console.warn(`[${platform}] Failed to load cursor from cloud:`, error)
    return null
  }
}

/**
 * Save cursor state to Convex syncCursors table.
 * Uses centralized auth internally.
 */
export async function saveCursor<T>(
  client: ConvexHttpClient,
  platform: SyncPlatform,
  cursorData: T,
  options?: CursorSaveOptions & { workspaceId?: string }
): Promise<void> {
  try {
    await withAuthRetry(
      () =>
        client.mutation(api.syncCursors.upsertSyncCursor, {
          platform,
          workspaceId: options?.workspaceId,
          cursorData,
          syncMode: options?.syncMode ?? 'incremental',
          fullSyncProgress: options?.fullSyncProgress,
        }),
      createAuthRetryOptions(client)
    )
  } catch (error) {
    console.warn(`[${platform}] Failed to save cursor to cloud:`, error)
  }
}

/**
 * Clear cursor from Convex syncCursors table.
 * Uses centralized auth internally.
 */
export async function clearCursor(
  client: ConvexHttpClient,
  platform: SyncPlatform,
  workspaceId?: string
): Promise<void> {
  try {
    await withAuthRetry(
      () =>
        client.mutation(api.syncCursors.deleteSyncCursor, {
          platform,
          workspaceId,
        }),
      createAuthRetryOptions(client)
    )
    console.log(`[${platform}] Cleared cursor from cloud`)
  } catch (error) {
    console.warn(`[${platform}] Failed to clear cursor from cloud:`, error)
  }
}

// ============================================================================
// Progress Reporting
// ============================================================================

/**
 * Create a progress reporter that tracks state and notifies listeners.
 */
export function createProgressReporter<T extends object>(
  initial: T,
  onProgress?: (progress: T) => void
): {
  update: (partial: Partial<T>) => void
  get: () => T
  setCallback: (cb: (progress: T) => void) => void
} {
  let progress = { ...initial }
  let callback = onProgress

  return {
    update(partial: Partial<T>) {
      progress = { ...progress, ...partial }
      callback?.(progress)
    },
    get() {
      return { ...progress }
    },
    setCallback(cb: (progress: T) => void) {
      callback = cb
    },
  }
}

// ============================================================================
// Sync Lifecycle Helpers
// ============================================================================

/**
 * Create an interval manager for periodic sync.
 */
export function createSyncInterval(
  runSync: () => Promise<void>,
  intervalMs: number
): {
  start: () => void
  stop: () => void
  isRunning: () => boolean
} {
  let intervalId: NodeJS.Timeout | null = null

  return {
    start() {
      if (intervalId) return
      intervalId = setInterval(() => runSync(), intervalMs)
    },
    stop() {
      if (intervalId) {
        clearInterval(intervalId)
        intervalId = null
      }
    },
    isRunning() {
      return intervalId !== null
    },
  }
}

/**
 * Guard to prevent concurrent sync runs.
 */
export function createSyncGuard(): {
  tryStart: () => boolean
  finish: () => void
  isRunning: () => boolean
} {
  let running = false

  return {
    tryStart() {
      if (running) return false
      running = true
      return true
    },
    finish() {
      running = false
    },
    isRunning() {
      return running
    },
  }
}
