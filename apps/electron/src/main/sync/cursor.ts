/**
 * Cursor Management
 *
 * Load, save, and clear sync cursors from Convex.
 * Cursors track sync state across sessions and devices.
 */

import { ConvexHttpClient } from 'convex/browser'
import { api } from '@prm/convex'
import { withAuthRetry } from '../auth/auth-utils'
import { electronEnv } from '@prm/env/electron'
import { createAuthRetryOptions, setConvexAuth } from '../auth/auth-manager'
import type { SyncPlatform } from '@prm/shared'

// Re-export centralized auth helpers for convenience
export { createAuthRetryOptions, setConvexAuth }

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
