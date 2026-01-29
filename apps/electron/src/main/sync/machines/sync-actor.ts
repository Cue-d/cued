/**
 * XState v5 machine for a per-platform sync actor.
 *
 * Each platform (iMessage, LinkedIn, Slack workspace, etc.) gets its own
 * sync actor that handles:
 * - Executing sync operations
 * - Exponential backoff on errors
 * - Reporting completion to parent orchestrator
 */

import { setup, assign, fromPromise, sendParent } from 'xstate'
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

type SyncActorEvents =
  | { type: 'SYNC' }
  | { type: 'STOP' }
  | { type: 'RESET_BACKOFF' }

// ============================================================================
// Helper to get actor ID
// ============================================================================

function getActorId(context: SyncActorContext): string {
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
      context: {} as SyncActorContext,
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
        const doneEvent = event as { type: string; output: SyncResult }
        return {
          lastSyncAt: Date.now(),
          lastError: null,
          totalMessagesSynced:
            context.totalMessagesSynced + (doneEvent.output?.messagesSynced ?? 0),
          totalContactsSynced:
            context.totalContactsSynced + (doneEvent.output?.contactsSynced ?? 0),
        }
      }),
      recordError: assign(({ event }) => {
        const errorEvent = event as { type: string; error: unknown }
        const errorMessage =
          errorEvent.error instanceof Error
            ? errorEvent.error.message
            : String(errorEvent.error)
        return {
          lastError: errorMessage,
        }
      }),
      notifyParentComplete: sendParent(({ context }) => ({
        type: 'ACTOR_COMPLETED' as const,
        actorId: getActorId(context),
        phase: config.phase,
      })),
      notifyParentError: sendParent(({ context }) => ({
        type: 'ACTOR_ERROR' as const,
        actorId: getActorId(context),
        error: context.lastError ?? 'Unknown error',
      })),
      logSyncStart: ({ context }) => {
        console.log(`[SyncActor:${getActorId(context)}] Starting sync...`)
      },
      logSyncComplete: ({ context, event }) => {
        const doneEvent = event as { type: string; output: SyncResult }
        console.log(
          `[SyncActor:${getActorId(context)}] Sync complete. Messages: ${doneEvent.output?.messagesSynced ?? 0}, Contacts: ${doneEvent.output?.contactsSynced ?? 0}`
        )
      },
      logSyncError: ({ context, event }) => {
        const errorEvent = event as { type: string; error: unknown }
        const errorMessage =
          errorEvent.error instanceof Error
            ? errorEvent.error.message
            : String(errorEvent.error)
        console.error(`[SyncActor:${getActorId(context)}] Sync error: ${errorMessage}`)
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
    },
    initial: 'idle',
    states: {
      idle: {
        on: {
          SYNC: {
            target: 'syncing',
            actions: ['logSyncStart'],
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
              'notifyParentComplete',
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
              target: 'idle',
              actions: [
                'recordError',
                'logSyncError',
                'notifyParentError',
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
