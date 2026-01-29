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
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[IMessageSync] Error:', errorMessage)
      return {
        success: false,
        error: errorMessage,
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
        console.error('[ContactsSync] Completed with errors:', {
          errorCount: result.errors.length,
          errors: result.errors,
          partialSuccess: result.contactsCount + result.updatedCount,
        })
      }

      return {
        success: result.errors.length === 0,
        contactsSynced: result.contactsCount + result.updatedCount,
        error: result.errors.length > 0
          ? `${result.errors.length} error(s): ${result.errors.slice(0, 3).join('; ')}${result.errors.length > 3 ? '...' : ''}`
          : undefined,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[ContactsSync] Error:', errorMessage)
      return {
        success: false,
        error: errorMessage,
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
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[LinkedInMessagesSync] Failed to get API client:', errorMessage)
      return {
        success: false,
        error: errorMessage,
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
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[LinkedInMessagesSync] Error:', errorMessage)
      return {
        success: false,
        error: errorMessage,
      }
    }
  }
}

/**
 * Create sync function for LinkedIn contacts.
 *
 * Note: LinkedIn contacts are discovered and synced as part of message sync
 * (conversations include participant info). This placeholder ensures the
 * contacts phase has a LinkedIn actor to satisfy the two-phase barrier,
 * but the actual contact syncing happens in createLinkedInMessagesSyncFn.
 */
export function createLinkedInContactsSyncFn(
  options: SyncFunctionOptions
): SyncFunction {
  return async (): Promise<SyncResult> => {
    console.log('[LinkedInContactsSync] Skipping - contacts synced with messages')
    // LinkedIn contacts are discovered from conversation participants during message sync.
    // This placeholder satisfies the two-phase architecture requirement.
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
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`[SlackSync:${teamId}] Error:`, errorMessage)
      return {
        success: false,
        error: errorMessage,
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
