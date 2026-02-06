/**
 * XState v5 Orchestrator Machine
 *
 * Coordinates two-phase sync:
 * Phase 1: Contacts sync (macOS Contacts, LinkedIn contacts)
 * Phase 2: Messages sync (iMessage, LinkedIn, Slack) - starts after contacts complete
 *
 * This ensures contacts are available before processing messages for proper
 * contact resolution.
 */

import { setup, assign, createActor, type ActorRefFrom } from 'xstate'
import {
  createSyncActorMachine,
  type SyncActorInput,
  type SyncActorContextExtended,
} from './sync-actor.js'
import { type SyncPhase, SYNC_CONFIGS, getSyncKey } from '../types.js'

// ============================================================================
// Types
// ============================================================================

type SyncActorRef = ActorRefFrom<ReturnType<typeof createSyncActorMachine>>
type Subscription = { unsubscribe: () => void }

export interface OrchestratorContext {
  /** Registered sync actors by key (syncType or syncType:workspaceId) */
  actors: Map<string, SyncActorRef>
  /** Actor configs for spawning */
  actorConfigs: Map<string, SyncActorInput>
  /** Actors that have completed in current sync cycle */
  completedActors: Set<string>
  /** Subscriptions to actor state changes */
  actorSubscriptions: Map<string, Subscription>
  /** Whether currently running a sync cycle */
  isRunning: boolean
  /** Last error if any */
  lastError: string | null
  /** Last full sync timestamp */
  lastFullSyncAt: number | null
  /** Whether a sync was requested while running */
  pendingSyncRequest: boolean
}

export type OrchestratorEvent =
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'SYNC_NOW' }
  | { type: 'REGISTER_ACTOR'; config: SyncActorInput }
  | { type: 'UNREGISTER_ACTOR'; actorId: string }
  | { type: 'ACTOR_COMPLETED'; actorId: string; phase: SyncPhase }
  | { type: 'ACTOR_ERROR'; actorId: string; error: string }
  | { type: 'CONTACTS_PHASE_DONE' }
  | { type: 'MESSAGES_PHASE_DONE' }

// ============================================================================
// Helper Functions
// ============================================================================

function getActorsForPhase(
  actorConfigs: Map<string, SyncActorInput>,
  phase: SyncPhase
): string[] {
  return Array.from(actorConfigs.entries())
    .filter(([, config]) => SYNC_CONFIGS[config.syncType].phase === phase)
    .map(([key]) => key)
}

function isPhaseComplete(
  completedActors: Set<string>,
  actorConfigs: Map<string, SyncActorInput>,
  phase: SyncPhase
): boolean {
  const phaseActors = getActorsForPhase(actorConfigs, phase)
  return phaseActors.every((id) => completedActors.has(id))
}

function wouldCompletePhase(
  completedActors: Set<string>,
  actorConfigs: Map<string, SyncActorInput>,
  phase: SyncPhase,
  newActorId: string
): boolean {
  const withNew = new Set(completedActors)
  withNew.add(newActorId)
  return isPhaseComplete(withNew, actorConfigs, phase)
}

// ============================================================================
// Orchestrator Machine
// ============================================================================

export const orchestratorMachine = setup({
  types: {
    context: {} as OrchestratorContext,
    events: {} as OrchestratorEvent,
  },
  actions: {
    registerActor: assign(({ context, event }) => {
      if (event.type !== 'REGISTER_ACTOR') return {}
      const key = getSyncKey(event.config.syncType, event.config.workspaceId)
      const newConfigs = new Map(context.actorConfigs)
      newConfigs.set(key, event.config)
      return { actorConfigs: newConfigs }
    }),
    unregisterActor: assign(({ context, event }) => {
      if (event.type !== 'UNREGISTER_ACTOR') return {}
      const newConfigs = new Map(context.actorConfigs)
      const newActors = new Map(context.actors)
      const newSubscriptions = new Map(context.actorSubscriptions)

      // Clean up subscription
      const subscription = newSubscriptions.get(event.actorId)
      if (subscription) {
        subscription.unsubscribe()
        newSubscriptions.delete(event.actorId)
      }

      // Stop and remove actor
      const actor = newActors.get(event.actorId)
      if (actor) {
        actor.send({ type: 'STOP' })
        newActors.delete(event.actorId)
      }

      newConfigs.delete(event.actorId)
      return { actorConfigs: newConfigs, actors: newActors, actorSubscriptions: newSubscriptions }
    }),
    spawnActors: assign(({ context, self }) => {
      const newActors = new Map(context.actors)
      const newSubscriptions = new Map(context.actorSubscriptions)

      for (const [key, config] of context.actorConfigs) {
        if (newActors.has(key)) continue

        const machine = createSyncActorMachine(config)
        const actor = createActor(machine, { input: config })
        const phase = SYNC_CONFIGS[config.syncType].phase

        // Track previous state to only fire event on transition to complete
        let prevSyncCycleComplete = false
        const subscription = actor.subscribe((snapshot) => {
          try {
            const actorContext = snapshot.context as SyncActorContextExtended
            // Only send event when transitioning from incomplete to complete
            if (actorContext.syncCycleComplete && !prevSyncCycleComplete) {
              if (actorContext.lastSyncSuccess) {
                self.send({ type: 'ACTOR_COMPLETED', actorId: key, phase })
              } else {
                const error = actorContext.lastError ?? `Sync failed for ${config.syncType}`
                console.error(`[Orchestrator] Actor ${key} failed:`, error)
                self.send({ type: 'ACTOR_ERROR', actorId: key, error })
              }
            }
            prevSyncCycleComplete = actorContext.syncCycleComplete
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err)
            console.error(`[Orchestrator] Error in actor subscription for ${key}:`, err)
            self.send({ type: 'ACTOR_ERROR', actorId: key, error: `Subscription error: ${errorMsg}` })
          }
        })

        actor.start()
        newActors.set(key, actor as SyncActorRef)
        newSubscriptions.set(key, subscription)
      }
      return { actors: newActors, actorSubscriptions: newSubscriptions }
    }),
    stopAllActors: assign(({ context }) => {
      for (const [, subscription] of context.actorSubscriptions) {
        subscription.unsubscribe()
      }
      for (const [, actor] of context.actors) {
        actor.send({ type: 'STOP' })
      }
      return { actors: new Map(), actorSubscriptions: new Map(), isRunning: false }
    }),
    clearCompletedActors: assign({
      completedActors: () => new Set<string>(),
    }),
    markActorCompleted: assign(({ context, event }) => {
      if (event.type !== 'ACTOR_COMPLETED') return {}
      const newCompleted = new Set(context.completedActors)
      newCompleted.add(event.actorId)
      return { completedActors: newCompleted }
    }),
    recordError: assign(({ event }) => {
      if (event.type !== 'ACTOR_ERROR') return {}
      console.error(`[Orchestrator] Actor error: ${event.actorId} - ${event.error}`)
      return { lastError: event.error }
    }),
    // Mark actor as completed even on error so phase can proceed
    markActorCompletedFromError: assign(({ context, event }) => {
      if (event.type !== 'ACTOR_ERROR') return {}
      const newCompleted = new Set(context.completedActors)
      newCompleted.add(event.actorId)
      return { completedActors: newCompleted }
    }),
    recordSyncComplete: assign({
      lastFullSyncAt: () => {
        console.log('[Orchestrator] Sync cycle complete')
        return Date.now()
      },
      isRunning: () => false,
    }),
    startContactsPhase: ({ context }) => {
      const contactsActors = getActorsForPhase(context.actorConfigs, 'contacts')
      console.log(`[Orchestrator] Starting contacts phase (${contactsActors.length} actors)`)
      for (const key of contactsActors) {
        context.actors.get(key)?.send({ type: 'SYNC' })
      }
    },
    startMessagesPhase: ({ context }) => {
      const messagesActors = getActorsForPhase(context.actorConfigs, 'messages')
      console.log(`[Orchestrator] Starting messages phase (${messagesActors.length} actors)`)
      for (const key of messagesActors) {
        context.actors.get(key)?.send({ type: 'SYNC' })
      }
    },
    setRunning: assign({ isRunning: () => true }),
    queueSyncRequest: assign({
      pendingSyncRequest: () => true,
    }),
    clearPendingSyncRequest: assign({ pendingSyncRequest: () => false }),
  },
  guards: {
    hasContactsActors: ({ context }) => {
      return getActorsForPhase(context.actorConfigs, 'contacts').length > 0
    },
    hasMessagesActors: ({ context }) => {
      return getActorsForPhase(context.actorConfigs, 'messages').length > 0
    },
    isContactsPhaseComplete: ({ context }) => {
      return isPhaseComplete(context.completedActors, context.actorConfigs, 'contacts')
    },
    isMessagesPhaseComplete: ({ context }) => {
      return isPhaseComplete(context.completedActors, context.actorConfigs, 'messages')
    },
    hasPendingSyncRequest: ({ context }) => context.pendingSyncRequest,
  },
}).createMachine({
  id: 'sync-orchestrator',
  context: {
    actors: new Map(),
    actorConfigs: new Map(),
    completedActors: new Set(),
    actorSubscriptions: new Map(),
    isRunning: false,
    lastError: null,
    lastFullSyncAt: null,
    pendingSyncRequest: false,
  },
  initial: 'idle',
  on: {
    REGISTER_ACTOR: {
      actions: ['registerActor'],
    },
    UNREGISTER_ACTOR: {
      actions: ['unregisterActor'],
    },
  },
  states: {
    idle: {
      on: {
        START: {
          target: 'running',
          actions: ['spawnActors'],
        },
        SYNC_NOW: {
          target: 'running',
          actions: ['spawnActors'],
        },
      },
    },
    running: {
      initial: 'contactsPhase',
      entry: ['setRunning', 'clearCompletedActors'],
      on: {
        STOP: {
          target: 'stopped',
          actions: ['stopAllActors'],
        },
        // Queue sync request if one arrives during running state
        SYNC_NOW: {
          actions: ['queueSyncRequest'],
        },
        // ACTOR_ERROR also marks the actor as completed so phase can proceed
        // This handles the case where an actor exhausts retries
        ACTOR_ERROR: {
          actions: ['recordError', 'markActorCompletedFromError'],
        },
      },
      states: {
        contactsPhase: {
          entry: ['startContactsPhase'],
          always: [
            {
              guard: 'isContactsPhaseComplete',
              target: 'barrier',
            },
          ],
          on: {
            ACTOR_COMPLETED: [
              {
                guard: ({ context, event }) =>
                  event.type === 'ACTOR_COMPLETED' &&
                  wouldCompletePhase(context.completedActors, context.actorConfigs, 'contacts', event.actorId),
                target: 'barrier',
                actions: ['markActorCompleted'],
              },
              {
                actions: ['markActorCompleted'],
              },
            ],
          },
        },
        barrier: {
          always: [
            {
              guard: 'hasMessagesActors',
              target: 'messagesPhase',
            },
            {
              target: '#sync-orchestrator.complete',
            },
          ],
        },
        messagesPhase: {
          entry: ['startMessagesPhase'],
          always: [
            {
              guard: 'isMessagesPhaseComplete',
              target: '#sync-orchestrator.complete',
            },
          ],
          on: {
            ACTOR_COMPLETED: [
              {
                guard: ({ context, event }) =>
                  event.type === 'ACTOR_COMPLETED' &&
                  wouldCompletePhase(context.completedActors, context.actorConfigs, 'messages', event.actorId),
                target: '#sync-orchestrator.complete',
                actions: ['markActorCompleted'],
              },
              {
                actions: ['markActorCompleted'],
              },
            ],
          },
        },
      },
    },
    complete: {
      entry: ['recordSyncComplete'],
      always: [
        {
          guard: 'hasPendingSyncRequest',
          target: 'running',
          actions: ['clearPendingSyncRequest'],
        },
        {
          target: 'idle',
        },
      ],
    },
    stopped: {
      type: 'final',
    },
  },
})

export type OrchestratorMachine = typeof orchestratorMachine
