/**
 * Types for XState-based Sync Engine
 *
 * Defines sync type identifiers, configurations, and event types
 * for the two-phase orchestrated sync system.
 */

// ============================================================================
// Sync Type Identifiers
// ============================================================================

/**
 * Sync type identifiers.
 * - contacts: macOS Contacts.app sync (phase 1: contacts)
 * - imessage: iMessage messages sync (phase 2: messages)
 * - linkedin: LinkedIn messages sync (phase 2: messages)
 * - linkedin_contacts: LinkedIn contacts sync (phase 1: contacts)
 * - slack: Slack messages sync (phase 2: messages) - one per workspace
 */
export type SyncTypeId =
  | 'contacts'
  | 'imessage'
  | 'linkedin'
  | 'linkedin_contacts'
  | 'slack'

/**
 * Phase type for two-phase sync.
 * Phase 1 (contacts) completes before Phase 2 (messages) begins.
 */
export type SyncPhase = 'contacts' | 'messages'

// ============================================================================
// Sync Configuration
// ============================================================================

export interface SyncTypeConfig {
  /** Unique identifier for this sync type */
  id: SyncTypeId
  /** Human-readable label */
  label: string
  /** Which phase this sync belongs to */
  phase: SyncPhase
  /** Default sync interval in milliseconds */
  defaultIntervalMs: number
  /** Initial backoff delay for retries in milliseconds */
  initialBackoffMs: number
  /** Maximum backoff delay in milliseconds */
  maxBackoffMs: number
  /** Maximum retry attempts before giving up */
  maxRetries: number
  /** Whether this sync type supports event-driven triggers */
  supportsEventTrigger: boolean
  /** Whether this sync type supports multiple instances (e.g., Slack workspaces) */
  supportsMultipleInstances: boolean
}

/**
 * Static configuration for each sync type.
 */
export const SYNC_CONFIGS: Record<SyncTypeId, SyncTypeConfig> = {
  contacts: {
    id: 'contacts',
    label: 'macOS Contacts',
    phase: 'contacts',
    defaultIntervalMs: 5 * 60 * 1000, // 5 minutes (contacts change rarely)
    initialBackoffMs: 1000,
    maxBackoffMs: 30 * 1000,
    maxRetries: 3,
    supportsEventTrigger: true, // FSEvents
    supportsMultipleInstances: false,
  },
  linkedin_contacts: {
    id: 'linkedin_contacts',
    label: 'LinkedIn Contacts',
    phase: 'contacts',
    defaultIntervalMs: 10 * 60 * 1000, // 10 minutes
    initialBackoffMs: 2000,
    maxBackoffMs: 60 * 1000,
    maxRetries: 3,
    supportsEventTrigger: false,
    supportsMultipleInstances: false,
  },
  imessage: {
    id: 'imessage',
    label: 'iMessage',
    phase: 'messages',
    defaultIntervalMs: 5 * 1000, // 5 seconds
    initialBackoffMs: 1000,
    maxBackoffMs: 30 * 1000,
    maxRetries: 3,
    supportsEventTrigger: true, // FSEvents on chat.db
    supportsMultipleInstances: false,
  },
  linkedin: {
    id: 'linkedin',
    label: 'LinkedIn Messages',
    phase: 'messages',
    defaultIntervalMs: 5 * 60 * 1000, // 5 minutes (SSE provides real-time)
    initialBackoffMs: 2000,
    maxBackoffMs: 60 * 1000,
    maxRetries: 3,
    supportsEventTrigger: true, // SSE real-time events
    supportsMultipleInstances: false,
  },
  slack: {
    id: 'slack',
    label: 'Slack',
    phase: 'messages',
    defaultIntervalMs: 30 * 1000, // 30 seconds
    initialBackoffMs: 2000,
    maxBackoffMs: 60 * 1000,
    maxRetries: 3,
    supportsEventTrigger: false,
    supportsMultipleInstances: true, // Multiple workspaces
  },
}

// ============================================================================
// Sync Actor Types
// ============================================================================

/**
 * Context for a per-platform sync actor.
 */
export interface SyncActorContext {
  /** Sync type ID */
  syncType: SyncTypeId
  /** Optional workspace/instance ID (for multi-instance types like Slack) */
  workspaceId?: string
  /** Current retry count */
  retryCount: number
  /** Current backoff delay in ms */
  backoffMs: number
  /** Last sync timestamp */
  lastSyncAt: number | null
  /** Last error message if any */
  lastError: string | null
  /** Total messages synced (cumulative) */
  totalMessagesSynced: number
  /** Total contacts synced (cumulative) */
  totalContactsSynced: number
}

/**
 * Events that can be sent to a sync actor.
 */
export type SyncActorEvent =
  | { type: 'SYNC' } // Trigger a sync
  | { type: 'SYNC_COMPLETE'; messagesSynced?: number; contactsSynced?: number }
  | { type: 'SYNC_ERROR'; error: string }
  | { type: 'RESET_BACKOFF' }
  | { type: 'STOP' }

/**
 * States for a sync actor.
 */
export type SyncActorState = 'idle' | 'syncing' | 'backoff' | 'stopped'

// ============================================================================
// Orchestrator Types
// ============================================================================

/**
 * Context for the orchestrator machine.
 */
export interface OrchestratorContext {
  /** Current phase */
  currentPhase: SyncPhase | null
  /** Actors in contacts phase that have completed */
  completedContactsActors: Set<string>
  /** Actors in contacts phase total */
  totalContactsActors: number
  /** Actors in messages phase that have completed */
  completedMessagesActors: Set<string>
  /** Actors in messages phase total */
  totalMessagesActors: number
  /** Whether the engine is running */
  isRunning: boolean
  /** Last error if any */
  lastError: string | null
  /** Last full sync timestamp */
  lastFullSyncAt: number | null
}

/**
 * Events for the orchestrator machine.
 */
export type OrchestratorEvent =
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'SYNC_NOW' } // Trigger immediate sync
  | { type: 'ACTOR_COMPLETED'; actorId: string; phase: SyncPhase }
  | { type: 'ACTOR_ERROR'; actorId: string; error: string }
  | { type: 'CONTACTS_PHASE_COMPLETE' }
  | { type: 'MESSAGES_PHASE_COMPLETE' }
  | { type: 'REGISTER_ACTOR'; actorId: string; phase: SyncPhase }
  | { type: 'UNREGISTER_ACTOR'; actorId: string }

/**
 * States for the orchestrator machine.
 */
export type OrchestratorState =
  | 'idle'
  | 'contactsPhase'
  | 'barrier' // Waiting for all contacts to complete
  | 'messagesPhase'
  | 'stopped'

// ============================================================================
// Engine Types
// ============================================================================

/**
 * Status of a single sync actor.
 */
export interface SyncActorStatus {
  syncType: SyncTypeId
  workspaceId?: string
  state: SyncActorState
  lastSyncAt: number | null
  lastError: string | null
  retryCount: number
  totalMessagesSynced: number
  totalContactsSynced: number
}

/**
 * Overall sync engine status.
 */
export interface SyncEngineStatus {
  isRunning: boolean
  currentPhase: SyncPhase | null
  lastFullSyncAt: number | null
  actors: SyncActorStatus[]
  error: string | null
}

/**
 * Progress event emitted by the sync engine.
 * Compatible with existing UnifiedSyncProgress for backwards compat.
 */
export interface SyncProgress {
  status: 'idle' | 'syncing' | 'error'
  currentPlatform?: SyncTypeId
  lastSyncAt?: number
  platforms: {
    contacts?: { synced: number; updated: number }
    linkedin?: { contacts: number; messages: number }
    slack?: { messages: number; workspaces: number }
    imessage?: { messages: number }
  }
  error?: string
}

/**
 * Result from a sync operation.
 */
export interface SyncResult {
  success: boolean
  messagesSynced?: number
  contactsSynced?: number
  error?: string
}

// ============================================================================
// Sync Function Types
// ============================================================================

/**
 * Function signature for sync operations.
 * Returns a promise that resolves with sync result.
 */
export type SyncFunction = () => Promise<SyncResult>

/**
 * Registry of sync functions by type (and optional workspace ID).
 */
export type SyncFunctionRegistry = Map<string, SyncFunction>

/**
 * Get a unique key for a sync type + optional workspace.
 */
export function getSyncKey(syncType: SyncTypeId, workspaceId?: string): string {
  return workspaceId ? `${syncType}:${workspaceId}` : syncType
}
