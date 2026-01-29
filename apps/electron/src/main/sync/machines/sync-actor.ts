/**
 * XState v5 machine for a per-platform sync actor.
 *
 * Each platform (iMessage, LinkedIn, Slack workspace, etc.) gets its own
 * sync actor that handles:
 * - Executing sync operations
 * - Exponential backoff on errors
 * - Tracking completion status (engine subscribes to state changes)
 *
 * Note: Does NOT use sendParent() since actors are created with createActor()
 * rather than spawn(). The engine subscribes to actor state changes instead.
 */

import { setup, assign, fromPromise } from 'xstate'
import {
  type SyncTypeId,
  type SyncActorContext,
  type SyncResult,
  type SyncFunction,
  SYNC_CONFIGS,
} from '../types'

// ============================================================================
// Actor Input
// ============================================================================

export interface SyncActorInput {
  syncType: SyncTypeId
  workspaceId?: string
  syncFn: SyncFunction
}

// ============================================================================
// Actor Events
// ============================================================================

export type SyncActorEvents =
  | { type: 'SYNC' }
  | { type: 'STOP' }
  | { type: 'RESET_BACKOFF' }

// ============================================================================
// Extended Context with completion tracking
// ============================================================================

export interface SyncActorContextExtended extends SyncActorContext {
  /** Whether the last sync cycle completed (success or max retries exhausted) */
  syncCycleComplete: boolean
  /** Whether the last sync cycle was successful */
  lastSyncSuccess: boolean
}

// ============================================================================
// Helper to get actor ID
// ============================================================================

export function getActorId(context: SyncActorContext): string {
  return context.workspaceId
    ? `${context.syncType}:${context.workspaceId}`
    : context.syncType
}

// ============================================================================
// Sync Actor Machine
// ============================================================================

export const createSyncActorMachine = (input: SyncActorInput) => {
  const config = SYNC_CONFIGS[input.syncType]

  return setup({
    types: {
      context: {} as SyncActorContextExtended,
      events: {} as SyncActorEvents,
      input: {} as SyncActorInput,
    },
    actors: {
      performSync: fromPromise<SyncResult, { syncFn: SyncFunction }>(
        async ({ input: actorInput }) => {
          return actorInput.syncFn()
        }
      ),
    },
    actions: {
      incrementRetry: assign({
        retryCount: ({ context }) => context.retryCount + 1,
        backoffMs: ({ context }) =>
          Math.min(context.backoffMs * 2, config.maxBackoffMs),
      }),
      resetRetry: assign({
        retryCount: () => 0,
        backoffMs: () => config.initialBackoffMs,
      }),
      recordSuccess: assign(({ context, event }) => {
        if (!('output' in event)) {
          console.error('[SyncActor] recordSuccess received event without output:', event)
          return {}
        }
        const output = event.output as SyncResult | undefined
        return {
          lastSyncAt: Date.now(),
          lastError: null,
          lastSyncSuccess: true,
          syncCycleComplete: true,
          totalMessagesSynced:
            context.totalMessagesSynced + (output?.messagesSynced ?? 0),
          totalContactsSynced:
            context.totalContactsSynced + (output?.contactsSynced ?? 0),
        }
      }),
      recordError: assign(({ event }) => {
        if (!('error' in event)) {
          console.error('[SyncActor] recordError received event without error:', event)
          return { lastError: 'Unknown error' }
        }
        const error = event.error
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        return {
          lastError: errorMessage,
          lastSyncSuccess: false,
        }
      }),
      markCycleComplete: assign({
        syncCycleComplete: () => true,
      }),
      clearCycleComplete: assign({
        syncCycleComplete: () => false,
      }),
      logSyncStart: ({ context }) => {
        console.log(`[SyncActor:${getActorId(context)}] Starting sync...`)
      },
      logSyncComplete: ({ context, event }) => {
        if (!('output' in event)) return
        const output = event.output as SyncResult | undefined
        console.log(
          `[SyncActor:${getActorId(context)}] Sync complete. Messages: ${output?.messagesSynced ?? 0}, Contacts: ${output?.contactsSynced ?? 0}`
        )
      },
      logSyncError: ({ context, event }) => {
        if (!('error' in event)) return
        const error = event.error
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        console.error(`[SyncActor:${getActorId(context)}] Sync error: ${errorMessage}`)
      },
      logMaxRetriesExhausted: ({ context }) => {
        console.error(
          `[SyncActor:${getActorId(context)}] Max retries (${config.maxRetries}) exhausted. Last error: ${context.lastError}`
        )
      },
    },
    guards: {
      canRetry: ({ context }) => context.retryCount < config.maxRetries,
    },
    delays: {
      backoffDelay: ({ context }) => context.backoffMs,
    },
  }).createMachine({
    id: input.workspaceId
      ? `sync-actor-${input.syncType}-${input.workspaceId}`
      : `sync-actor-${input.syncType}`,
    context: {
      syncType: input.syncType,
      workspaceId: input.workspaceId,
      retryCount: 0,
      backoffMs: config.initialBackoffMs,
      lastSyncAt: null,
      lastError: null,
      totalMessagesSynced: 0,
      totalContactsSynced: 0,
      syncCycleComplete: false,
      lastSyncSuccess: false,
    },
    initial: 'idle',
    states: {
      idle: {
        on: {
          SYNC: {
            target: 'syncing',
            actions: ['clearCycleComplete', 'logSyncStart'],
          },
          STOP: 'stopped',
        },
      },
      syncing: {
        invoke: {
          id: 'performSync',
          src: 'performSync',
          input: { syncFn: input.syncFn },
          onDone: {
            target: 'idle',
            actions: [
              'resetRetry',
              'recordSuccess',
              'logSyncComplete',
            ],
          },
          onError: [
            {
              guard: 'canRetry',
              target: 'backoff',
              actions: [
                'incrementRetry',
                'recordError',
                'logSyncError',
              ],
            },
            {
              // Max retries exhausted - mark cycle complete with error
              target: 'idle',
              actions: [
                'recordError',
                'logSyncError',
                'logMaxRetriesExhausted',
                'markCycleComplete',
              ],
            },
          ],
        },
        on: {
          STOP: 'stopped',
        },
      },
      backoff: {
        after: {
          backoffDelay: {
            target: 'syncing',
            actions: ['logSyncStart'],
          },
        },
        on: {
          STOP: 'stopped',
          RESET_BACKOFF: {
            target: 'idle',
            actions: ['resetRetry'],
          },
        },
      },
      stopped: {
        type: 'final',
      },
    },
  })
}

export type SyncActorMachine = ReturnType<typeof createSyncActorMachine>
