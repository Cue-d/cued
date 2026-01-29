/**
 * Sync Function Wrappers
 *
 * Adapts existing platform sync managers to the SyncFunction interface
 * expected by the XState sync engine.
 *
 * Each wrapper:
 * 1. Calls the underlying platform sync logic
 * 2. Returns a SyncResult with messagesSynced/contactsSynced counts
 */

import { type SyncResult, type SyncFunction } from './types'
import { getIMessageSyncManager } from '../platforms/imessage'
import {
  getLinkedInSyncManager,
  type LinkedInScraper,
} from '../platforms/linkedin'
import {
  getSlackSyncManager,
  getAllSlackCredentials,
} from '../platforms/slack'
import { syncContactsToConvex } from '../platforms/contacts/sync'

// ============================================================================
// Types
// ============================================================================

export interface SyncFunctionOptions {
  getAuthToken: () => Promise<string | null>
  linkedInScraper?: LinkedInScraper
}

// ============================================================================
// iMessage Sync
// ============================================================================

/**
 * Create sync function for iMessage messages.
 */
export function createIMessageSyncFn(options: SyncFunctionOptions): SyncFunction {
  return async (): Promise<SyncResult> => {
    const manager = getIMessageSyncManager()

    // Get initial count
    const before = manager.getProgress()
    const initialMessages = before.totalMessagesSynced

    try {
      await manager.runSync()

      const after = manager.getProgress()
      const messagesSynced = after.totalMessagesSynced - initialMessages

      if (after.status === 'error') {
        return {
          success: false,
          error: after.error ?? 'iMessage sync failed',
        }
      }

      return {
        success: true,
        messagesSynced: Math.max(0, messagesSynced),
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}

// ============================================================================
// Contacts Sync
// ============================================================================

/**
 * Create sync function for macOS Contacts.
 */
export function createContactsSyncFn(options: SyncFunctionOptions): SyncFunction {
  return async (): Promise<SyncResult> => {
    try {
      const result = await syncContactsToConvex(options.getAuthToken)

      if (result.errors.length > 0) {
        console.warn('[ContactsSync] Errors:', result.errors.slice(0, 3))
      }

      return {
        success: result.errors.length === 0,
        contactsSynced: result.contactsCount + result.updatedCount,
        error: result.errors.length > 0 ? result.errors[0] : undefined,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}

// ============================================================================
// LinkedIn Sync
// ============================================================================

/**
 * Create sync function for LinkedIn messages.
 */
export function createLinkedInMessagesSyncFn(
  options: SyncFunctionOptions
): SyncFunction {
  return async (): Promise<SyncResult> => {
    if (!options.linkedInScraper) {
      return {
        success: false,
        error: 'LinkedIn scraper not provided',
      }
    }

    const manager = getLinkedInSyncManager()

    // Check if logged in
    const isLoggedIn = await options.linkedInScraper.checkLoginStatus()
    if (!isLoggedIn) {
      return {
        success: false,
        error: 'LinkedIn not logged in',
      }
    }

    // Ensure client is set
    try {
      const apiClient = await options.linkedInScraper.getApiClient()
      manager.setClient(apiClient)
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }

    // Get initial counts
    const before = manager.getProgress()
    const initialMessages = before.totalMessagesSynced

    try {
      await manager.runSync()

      const after = manager.getProgress()
      const messagesSynced = after.totalMessagesSynced - initialMessages

      if (after.status === 'error') {
        return {
          success: false,
          error: after.error ?? 'LinkedIn sync failed',
        }
      }

      return {
        success: true,
        messagesSynced: Math.max(0, messagesSynced),
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}

/**
 * Create sync function for LinkedIn contacts.
 * Note: LinkedIn contacts are synced as part of messages sync - this is a placeholder.
 */
export function createLinkedInContactsSyncFn(
  options: SyncFunctionOptions
): SyncFunction {
  return async (): Promise<SyncResult> => {
    // LinkedIn contacts are synced as part of messages sync
    // This placeholder exists for the two-phase architecture
    return {
      success: true,
      contactsSynced: 0,
    }
  }
}

// ============================================================================
// Slack Sync
// ============================================================================

/**
 * Create sync function for a specific Slack workspace.
 */
export function createSlackSyncFn(
  options: SyncFunctionOptions,
  teamId: string
): SyncFunction {
  return async (): Promise<SyncResult> => {
    const manager = getSlackSyncManager({ teamId })

    if (!manager.isAuthenticated()) {
      // Try to initialize
      const initialized = await manager.initialize()
      if (!initialized) {
        return {
          success: false,
          error: `Slack workspace ${teamId} not authenticated`,
        }
      }
    }

    // Get initial counts
    const before = manager.getProgress()
    const initialMessages = before.totalMessagesSynced

    try {
      await manager.runSync()

      const after = manager.getProgress()
      const messagesSynced = after.totalMessagesSynced - initialMessages

      if (after.status === 'error') {
        return {
          success: false,
          error: after.error ?? 'Slack sync failed',
        }
      }

      return {
        success: true,
        messagesSynced: Math.max(0, messagesSynced),
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create all sync functions and return them with their type IDs.
 * Also returns workspace IDs for multi-instance types like Slack.
 */
export interface SyncFunctionRegistration {
  syncType: 'contacts' | 'imessage' | 'linkedin' | 'linkedin_contacts' | 'slack'
  workspaceId?: string
  syncFn: SyncFunction
}

export async function createAllSyncFunctions(
  options: SyncFunctionOptions
): Promise<SyncFunctionRegistration[]> {
  const registrations: SyncFunctionRegistration[] = []

  // Contacts sync (phase 1)
  registrations.push({
    syncType: 'contacts',
    syncFn: createContactsSyncFn(options),
  })

  // iMessage sync (phase 2)
  registrations.push({
    syncType: 'imessage',
    syncFn: createIMessageSyncFn(options),
  })

  // LinkedIn contacts sync (phase 1) - placeholder
  if (options.linkedInScraper) {
    registrations.push({
      syncType: 'linkedin_contacts',
      syncFn: createLinkedInContactsSyncFn(options),
    })

    // LinkedIn messages sync (phase 2)
    registrations.push({
      syncType: 'linkedin',
      syncFn: createLinkedInMessagesSyncFn(options),
    })
  }

  // Slack workspaces (phase 2)
  const slackCredentials = getAllSlackCredentials()
  for (const creds of slackCredentials) {
    registrations.push({
      syncType: 'slack',
      workspaceId: creds.teamId,
      syncFn: createSlackSyncFn(options, creds.teamId),
    })
  }

  return registrations
}
