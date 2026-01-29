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

import { api } from '@prm/convex'
import { type SyncResult, type SyncFunction } from './types'
import { getIMessageSyncManager } from '../platforms/imessage'
import {
  getLinkedInSyncManager,
  type LinkedInScraper,
  type IncrementalScrapeResult,
} from '../platforms/linkedin'
import {
  getSlackSyncManager,
  getAllSlackCredentials,
} from '../platforms/slack'
import { syncContactsToConvex } from '../platforms/contacts/sync'
import { createConvexClient, setConvexAuth } from './cursor'

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
 * Uses incremental scraping to fetch new connections since last sync.
 */
export function createLinkedInContactsSyncFn(
  options: SyncFunctionOptions
): SyncFunction {
  return async (): Promise<SyncResult> => {
    if (!options.linkedInScraper) {
      return {
        success: false,
        error: 'LinkedIn scraper not provided',
      }
    }

    // Check if logged in
    const isLoggedIn = await options.linkedInScraper.checkLoginStatus()
    if (!isLoggedIn) {
      return {
        success: false,
        error: 'LinkedIn not logged in',
      }
    }

    try {
      // Initialize scraper for contacts sync (sets up Convex client with auth)
      const initialized = await options.linkedInScraper.initializeForContactsSync()
      if (!initialized) {
        return {
          success: false,
          error: 'Failed to initialize LinkedIn contacts sync - not authenticated',
        }
      }

      // Scrape connections incrementally (uses anchor-based cursor)
      console.log('[LinkedInContactsSync] Starting incremental scrape...')
      const result: IncrementalScrapeResult =
        await options.linkedInScraper.scrapeConnectionsIncremental()

      if (result.connections.length === 0) {
        console.log('[LinkedInContactsSync] No new connections to sync')
        return {
          success: true,
          contactsSynced: 0,
        }
      }

      console.log(
        `[LinkedInContactsSync] Found ${result.connections.length} new connections, syncing to Convex...`
      )

      // Convert connections to the format expected by syncSocialContacts
      const contacts = result.connections.map((conn) => ({
        name: `${conn.firstName} ${conn.lastName}`.trim(),
        handle: conn.profileUrl, // Will be normalized by Convex
        profileUrl: conn.profileUrl,
        headline: conn.headline ?? null,
        profileId: conn.profileId, // URN ID for matching with messaging contacts
      }))

      // Create Convex client and sync contacts
      const convexClient = createConvexClient()
      const token = await setConvexAuth(convexClient)
      if (!token) {
        return {
          success: false,
          error: 'Failed to authenticate with Convex',
        }
      }

      const syncResult = await convexClient.mutation(api.sync.syncSocialContacts, {
        platform: 'linkedin',
        contacts,
        syncedAt: Date.now(),
      })

      console.log(
        `[LinkedInContactsSync] Synced ${syncResult.newContacts} new, ${syncResult.updatedContacts} updated contacts`
      )

      return {
        success: syncResult.errors.length === 0,
        contactsSynced: syncResult.newContacts + syncResult.updatedContacts,
        error:
          syncResult.errors.length > 0
            ? `${syncResult.errors.length} error(s): ${syncResult.errors.slice(0, 3).join('; ')}${syncResult.errors.length > 3 ? '...' : ''}`
            : undefined,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[LinkedInContactsSync] Error:', errorMessage)
      return {
        success: false,
        error: errorMessage,
      }
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
