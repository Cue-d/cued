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

import { api } from '@cued/convex'
import { type SyncResult, type SyncFunction } from './types.js'
import { getIMessageSyncManager } from '../platforms/imessage/index.js'
import {
  getLinkedInSyncManager,
  type LinkedInScraper,
  type IncrementalScrapeResult,
} from '../platforms/linkedin/index.js'
import {
  getSlackSyncManager,
  getAllSlackCredentials,
} from '../platforms/slack/index.js'
import { syncContactsToConvex } from '../platforms/contacts/sync.js'
import { createConvexClient, setConvexAuth } from './cursor.js'

// ============================================================================
// Types
// ============================================================================

export interface SyncFunctionOptions {
  getAuthToken: () => Promise<string | null>
  linkedInScraper?: LinkedInScraper
}

// ============================================================================
// Helpers
// ============================================================================

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatSyncErrors(errors: string[]): string {
  const preview = errors.slice(0, 3).join('; ')
  const suffix = errors.length > 3 ? '...' : ''
  return `${errors.length} error(s): ${preview}${suffix}`
}

// ============================================================================
// iMessage Sync
// ============================================================================

/**
 * Create sync function for iMessage messages.
 */
export function createIMessageSyncFn(_options: SyncFunctionOptions): SyncFunction {
  return async (): Promise<SyncResult> => {
    const manager = getIMessageSyncManager()
    const initialMessages = manager.getProgress().totalMessagesSynced

    try {
      await manager.runSync()

      const after = manager.getProgress()
      if (after.status === 'error') {
        const errorMessage = after.error ?? 'iMessage sync failed'
        console.error('[IMessageSync] Error:', errorMessage)
        throw new Error(errorMessage)
      }

      return {
        success: true,
        messagesSynced: Math.max(0, after.totalMessagesSynced - initialMessages),
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      console.error('[IMessageSync] Error:', errorMessage)
      throw new Error(errorMessage)
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
      const totalSynced = result.contactsCount + result.updatedCount

      if (result.errors.length > 0) {
        const errorMessage = formatSyncErrors(result.errors)
        console.error('[ContactsSync] Completed with errors:', {
          errorCount: result.errors.length,
          errors: result.errors,
          partialSuccess: totalSynced,
        })
        throw new Error(errorMessage)
      }

      return {
        success: true,
        contactsSynced: totalSynced,
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      console.error('[ContactsSync] Error:', errorMessage)
      throw new Error(errorMessage)
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
      throw new Error('LinkedIn scraper not provided')
    }

    const isLoggedIn = await options.linkedInScraper.checkLoginStatus()
    if (!isLoggedIn) {
      throw new Error('LinkedIn not logged in')
    }

    const manager = getLinkedInSyncManager()

    try {
      const apiClient = await options.linkedInScraper.getApiClient()
      manager.setClient(apiClient)
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      console.error('[LinkedInMessagesSync] Failed to get API client:', errorMessage)
      throw new Error(errorMessage)
    }

    const initialMessages = manager.getProgress().totalMessagesSynced

    try {
      await manager.runSync()

      const after = manager.getProgress()
      if (after.status === 'error') {
        const errorMessage = after.error ?? 'LinkedIn sync failed'
        console.error('[LinkedInMessagesSync] Error:', errorMessage)
        throw new Error(errorMessage)
      }

      return {
        success: true,
        messagesSynced: Math.max(0, after.totalMessagesSynced - initialMessages),
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      console.error('[LinkedInMessagesSync] Error:', errorMessage)
      throw new Error(errorMessage)
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
      throw new Error('LinkedIn scraper not provided')
    }

    const isLoggedIn = await options.linkedInScraper.checkLoginStatus()
    if (!isLoggedIn) {
      throw new Error('LinkedIn not logged in')
    }

    try {
      const initialized = await options.linkedInScraper.initializeForContactsSync()
      if (!initialized) {
        throw new Error('Failed to initialize LinkedIn contacts sync - not authenticated')
      }

      console.log('[LinkedInContactsSync] Starting incremental scrape...')
      const result: IncrementalScrapeResult =
        await options.linkedInScraper.scrapeConnectionsIncremental()

      console.log('[LinkedInContactsSync] Scrape result:', JSON.stringify({
        hasConnections: !!result?.connections,
        connectionCount: result?.connections?.length ?? 'undefined',
        hitAnchor: result?.hitAnchor,
        pagesFetched: result?.pagesFetched,
      }))

      if (!result?.connections || result.connections.length === 0) {
        console.log('[LinkedInContactsSync] No new connections to sync')
        return { success: true, contactsSynced: 0 }
      }

      console.log(
        `[LinkedInContactsSync] Found ${result.connections.length} new connections, syncing to Convex...`
      )

      const contacts = result.connections.map((conn) => ({
        name: `${conn.firstName} ${conn.lastName}`.trim(),
        handle: conn.profileUrl,
        profileUrl: conn.profileUrl,
        headline: conn.headline ?? null,
        profileId: conn.profileId,
      }))

      const convexClient = createConvexClient()
      const token = await setConvexAuth(convexClient)
      if (!token) {
        throw new Error('Failed to authenticate with Convex')
      }

      const syncResult = await convexClient.mutation(api.sync.syncSocialContacts, {
        platform: 'linkedin',
        contacts,
        syncedAt: Date.now(),
      })

      console.log(
        `[LinkedInContactsSync] Synced ${syncResult.newContacts} new, ${syncResult.updatedContacts} updated contacts`
      )

      const totalSynced = syncResult.newContacts + syncResult.updatedContacts

      if (syncResult.errors.length > 0) {
        const errorMessage = formatSyncErrors(syncResult.errors)
        console.error('[LinkedInContactsSync] Completed with errors:', errorMessage)
        throw new Error(errorMessage)
      }

      return {
        success: true,
        contactsSynced: totalSynced,
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      console.error('[LinkedInContactsSync] Error:', errorMessage)
      throw new Error(errorMessage)
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
  _options: SyncFunctionOptions,
  teamId: string
): SyncFunction {
  return async (): Promise<SyncResult> => {
    const manager = getSlackSyncManager({ teamId })

    if (!manager.isAuthenticated()) {
      const initialized = await manager.initialize()
      if (!initialized) {
        throw new Error(`Slack workspace ${teamId} not authenticated`)
      }
    }

    const initialMessages = manager.getProgress().totalMessagesSynced

    try {
      await manager.runSync()

      const after = manager.getProgress()
      if (after.status === 'error') {
        const errorMessage = after.error ?? 'Slack sync failed'
        console.error(`[SlackSync:${teamId}] Error:`, errorMessage)
        throw new Error(errorMessage)
      }

      return {
        success: true,
        messagesSynced: Math.max(0, after.totalMessagesSynced - initialMessages),
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      console.error(`[SlackSync:${teamId}] Error:`, errorMessage)
      throw new Error(errorMessage)
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
