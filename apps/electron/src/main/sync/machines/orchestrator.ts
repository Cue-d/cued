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

import { setup, assign, createActor, type ActorRefFrom, type AnyActorRef } from 'xstate'
import {
  createSyncActorMachine,
  type SyncActorInput,
  type SyncActorContextExtended,
  getActorId,
} from './sync-actor'
import { type SyncPhase, type SyncTypeId, SYNC_CONFIGS, getSyncKey } from '../types'

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
  const result: string[] = []
  for (const [key, config] of actorConfigs) {
    if (SYNC_CONFIGS[config.syncType].phase === phase) {
      result.push(key)
    }
  }
  return result
}

function isPhaseComplete(
  completedActors: Set<string>,
  actorConfigs: Map<string, SyncActorInput>,
  phase: SyncPhase
): boolean {
  const phaseActors = getActorsForPhase(actorConfigs, phase)
  return phaseActors.every((id) => completedActors.has(id))
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
        if (!newActors.has(key)) {
          const machine = createSyncActorMachine(config)
          const actor = createActor(machine, { input: config })

          // Subscribe to actor state changes to detect completion
          const subscription = actor.subscribe((snapshot) => {
            const actorContext = snapshot.context as SyncActorContextExtended
            if (actorContext.syncCycleComplete) {
              const phase = SYNC_CONFIGS[config.syncType].phase
              if (actorContext.lastSyncSuccess) {
                self.send({ type: 'ACTOR_COMPLETED', actorId: key, phase })
              } else {
                self.send({
                  type: 'ACTOR_ERROR',
                  actorId: key,
                  error: actorContext.lastError ?? 'Unknown error',
                })
              }
            }
          })

          actor.start()
          newActors.set(key, actor as SyncActorRef)
          newSubscriptions.set(key, subscription)
          console.log(`[Orchestrator] Spawned actor: ${key}`)
        }
      }
      return { actors: newActors, actorSubscriptions: newSubscriptions }
    }),
    stopAllActors: assign(({ context }) => {
      // Unsubscribe from all actors first
      for (const [key, subscription] of context.actorSubscriptions) {
        subscription.unsubscribe()
        console.log(`[Orchestrator] Unsubscribed from actor: ${key}`)
      }
      // Then stop all actors
      for (const [key, actor] of context.actors) {
        console.log(`[Orchestrator] Stopping actor: ${key}`)
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
      console.log(`[Orchestrator] Marking errored actor as completed: ${event.actorId}`)
      return { completedActors: newCompleted }
    }),
    recordSyncComplete: assign({
      lastFullSyncAt: () => Date.now(),
      isRunning: () => false,
    }),
    startContactsPhase: ({ context }) => {
      console.log('[Orchestrator] Starting contacts phase')
      const contactsActors = getActorsForPhase(context.actorConfigs, 'contacts')
      for (const key of contactsActors) {
        const actor = context.actors.get(key)
        if (actor) {
          console.log(`[Orchestrator] Triggering sync for: ${key}`)
          actor.send({ type: 'SYNC' })
        }
      }
    },
    startMessagesPhase: ({ context }) => {
      console.log('[Orchestrator] Starting messages phase')
      const messagesActors = getActorsForPhase(context.actorConfigs, 'messages')
      for (const key of messagesActors) {
        const actor = context.actors.get(key)
        if (actor) {
          console.log(`[Orchestrator] Triggering sync for: ${key}`)
          actor.send({ type: 'SYNC' })
        }
      }
    },
    logPhaseComplete: (_, params: { phase: SyncPhase }) => {
      console.log(`[Orchestrator] ${params.phase} phase complete`)
    },
    setRunning: assign({ isRunning: () => true }),
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
                guard: ({ context, event }) => {
                  if (event.type !== 'ACTOR_COMPLETED') return false
                  const newCompleted = new Set(context.completedActors)
                  newCompleted.add(event.actorId)
                  return isPhaseComplete(newCompleted, context.actorConfigs, 'contacts')
                },
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
          entry: [{ type: 'logPhaseComplete', params: { phase: 'contacts' as SyncPhase } }],
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
                guard: ({ context, event }) => {
                  if (event.type !== 'ACTOR_COMPLETED') return false
                  const newCompleted = new Set(context.completedActors)
                  newCompleted.add(event.actorId)
                  return isPhaseComplete(newCompleted, context.actorConfigs, 'messages')
                },
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
      entry: [
        { type: 'logPhaseComplete', params: { phase: 'messages' as SyncPhase } },
        'recordSyncComplete',
      ],
      always: {
        target: 'idle',
      },
    },
    stopped: {
      type: 'final',
    },
  },
})

export type OrchestratorMachine = typeof orchestratorMachine
