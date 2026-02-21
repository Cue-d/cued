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
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type SyncResult, type SyncFunction } from './types.js'
import { getIMessageSyncManager } from '../platforms/imessage/index.js'
import {
  getLinkedInSyncManager,
  type LinkedInScraper,
  type IncrementalScrapeResult,
} from '../platforms/linkedin/index.js'
import {
  getTwitterSyncManager,
  type TwitterScraper,
} from '../platforms/twitter/index.js'
import {
  getSlackSyncManager,
  getAllSlackCredentials,
} from '../platforms/slack/index.js'
import {
  getSignalSyncManager,
  SignalClient,
  type SignalContact,
  loadSignalCredentials,
} from '../platforms/signal/index.js'
import { syncContactsToConvex } from '../platforms/contacts/sync.js'
import { createConvexClient, setConvexAuth } from './cursor.js'
import { getErrorMessage } from './error-utils.js'

// ============================================================================
// Types
// ============================================================================

export interface SyncFunctionOptions {
  getAuthToken: () => Promise<string | null>
  linkedInScraper?: LinkedInScraper
  twitterScraper?: TwitterScraper
}

function formatSyncErrors(errors: string[]): string {
  const preview = errors.slice(0, 3).join('; ')
  const suffix = errors.length > 3 ? '...' : ''
  return `${errors.length} error(s): ${preview}${suffix}`
}

const CHAT_DB_PATH = join(homedir(), 'Library', 'Messages', 'chat.db')

function hasFullDiskAccess(): boolean {
  try {
    accessSync(CHAT_DB_PATH, constants.R_OK)
    return true
  } catch {
    return false
  }
}

// ============================================================================
// iMessage Sync
// ============================================================================

let loggedMissingIMessageFullDiskAccess = false

/**
 * Create sync function for iMessage messages.
 */
export function createIMessageSyncFn(_options: SyncFunctionOptions): SyncFunction {
  return async (): Promise<SyncResult> => {
    if (!hasFullDiskAccess()) {
      if (!loggedMissingIMessageFullDiskAccess) {
        console.warn(
          '[IMessageSync] Full Disk Access is missing; skipping iMessage sync until permission is granted.'
        )
      }
      loggedMissingIMessageFullDiskAccess = true
      return {
        success: true,
        messagesSynced: 0,
      }
    }

    if (loggedMissingIMessageFullDiskAccess) {
      console.log('[IMessageSync] Full Disk Access restored; resuming iMessage sync.')
      loggedMissingIMessageFullDiskAccess = false
    }

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
        profileUrl: conn.profileUrl,
        headline: conn.headline ?? null,
        profileId: conn.profileId,
      }))

      const convexClient = createConvexClient()
      const token = await setConvexAuth(convexClient)
      if (!token) {
        throw new Error('Failed to authenticate with Convex')
      }

      const syncResult = await convexClient.mutation(api.sync.syncLinkedInContacts, {
        contacts,
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
// Twitter Sync
// ============================================================================

/**
 * Create sync function for Twitter/X messages.
 */
export function createTwitterMessagesSyncFn(
  options: SyncFunctionOptions
): SyncFunction {
  return async (): Promise<SyncResult> => {
    if (!options.twitterScraper) {
      throw new Error('Twitter scraper not provided')
    }

    const isLoggedIn = await options.twitterScraper.checkLoginStatus()
    if (!isLoggedIn) {
      throw new Error('Twitter not logged in')
    }

    const manager = getTwitterSyncManager()

    const apiClient = await options.twitterScraper.getApiClient()
    manager.setClient(apiClient)

    const initialMessages = manager.getProgress().totalMessagesSynced
    const initialContacts = manager.getProgress().totalContactsSynced

    await manager.runSync()

    const after = manager.getProgress()
    if (after.status === 'error') {
      throw new Error(after.error ?? 'Twitter sync failed')
    }

    return {
      success: true,
      messagesSynced: Math.max(0, after.totalMessagesSynced - initialMessages),
      contactsSynced: Math.max(0, after.totalContactsSynced - initialContacts),
    }
  }
}

/**
 * Create sync function for Twitter/X contacts (followers/following mutuals).
 * Uses BrowserWindow DOM scraping with 24h cooldown.
 */
export function createTwitterContactsSyncFn(
  options: SyncFunctionOptions
): SyncFunction {
  return async (): Promise<SyncResult> => {
    if (!options.twitterScraper) {
      throw new Error('Twitter scraper not provided')
    }

    const isLoggedIn = await options.twitterScraper.checkLoginStatus()
    if (!isLoggedIn) {
      throw new Error('Twitter not logged in')
    }

    const manager = getTwitterSyncManager()

    const apiClient = await options.twitterScraper.getApiClient()
    manager.setClient(apiClient)
    if (!apiClient.isSessionInitialized()) {
      await apiClient.initializeSession()
    }

    const result = await manager.syncContacts(options.twitterScraper)
    return {
      success: true,
      contactsSynced: result.contactsSynced,
    }
  }
}

// ============================================================================
// Signal Sync
// ============================================================================

/**
 * Create sync function for Signal messages.
 */
export function createSignalSyncFn(_options: SyncFunctionOptions): SyncFunction {
  return async (): Promise<SyncResult> => {
    const manager = getSignalSyncManager()
    const initialized = await manager.initialize()
    if (!initialized) {
      throw new Error('Signal not configured or unavailable')
    }

    const initialMessages = manager.getProgress().totalMessagesSynced

    await manager.runSync()

    const after = manager.getProgress()
    if (after.status === 'error') {
      throw new Error(after.error ?? 'Signal sync failed')
    }

    return {
      success: true,
      messagesSynced: Math.max(0, after.totalMessagesSynced - initialMessages),
    }
  }
}

/**
 * Create sync function for Signal contacts.
 * Fetches contacts from signal-cli and syncs to Convex using the shared contacts mutation.
 */
export function createSignalContactsSyncFn(_options: SyncFunctionOptions): SyncFunction {
  return async (): Promise<SyncResult> => {
    // Use the sync manager's client when available — it routes through the daemon
    // and avoids signal-cli data-directory lock contention with the running daemon.
    const manager = getSignalSyncManager()
    const initialized = await manager.initialize()
    const managerClient = initialized ? manager.getClient() : null

    let contacts: SignalContact[]

    if (managerClient) {
      contacts = await managerClient.listContacts()
    } else {
      // Fallback: standalone client (no daemon running)
      const credentials = loadSignalCredentials()
      if (!credentials) {
        throw new Error('Signal not configured')
      }

      const client = new SignalClient({
        account: credentials.account,
        cliPath: credentials.cliPath,
      })

      if (!(await client.isAvailable())) {
        throw new Error('signal-cli not available')
      }

      contacts = await client.listContacts()
    }
    if (contacts.length === 0) {
      return { success: true, contactsSynced: 0 }
    }

    // Transform Signal contacts to the shared contact input format
    const contactInputs = contacts.map((c: SignalContact) => {
      const name = c.name?.trim()
        || [c.profile?.givenName, c.profile?.familyName].filter(Boolean).join(' ').trim()
        || [c.givenName, c.familyName].filter(Boolean).join(' ').trim()
        || c.number
      return {
        displayName: name,
        company: null,
        phoneNumbers: [c.number],
        emails: [] as string[],
      }
    })

    const convexClient = createConvexClient()
    const token = await setConvexAuth(convexClient)
    if (!token) {
      throw new Error('Failed to authenticate with Convex')
    }

    // Use syncSignalContacts — merges with existing macOS contacts by phone number,
    // and tags new handles with platform "signal" so they link to Signal conversations
    const BATCH_SIZE = 50
    let totalNew = 0
    let totalUpdated = 0
    const errors: string[] = []

    for (let i = 0; i < contactInputs.length; i += BATCH_SIZE) {
      const batch = contactInputs.slice(i, i + BATCH_SIZE)
      try {
        const result = await convexClient.mutation(api.sync.syncSignalContacts, { contacts: batch })
        totalNew += result.contactsCount
        totalUpdated += result.updatedCount
        errors.push(...result.errors)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        errors.push(msg)
      }
    }

    const totalSynced = totalNew + totalUpdated

    if (errors.length > 0) {
      throw new Error(formatSyncErrors(errors))
    }

    return { success: true, contactsSynced: totalSynced }
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
  syncType: 'contacts' | 'imessage' | 'linkedin' | 'twitter' | 'twitter_contacts' | 'linkedin_contacts' | 'signal' | 'signal_contacts' | 'slack'
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

  // LinkedIn contacts sync (phase 1)
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

  // Twitter messages (phase 2) and contacts (phase 1)
  if (options.twitterScraper) {
    registrations.push({
      syncType: 'twitter_contacts',
      syncFn: createTwitterContactsSyncFn(options),
    })

    registrations.push({
      syncType: 'twitter',
      syncFn: createTwitterMessagesSyncFn(options),
    })
  }

  // Signal syncs - only register if credentials exist
  const signalCredentials = loadSignalCredentials()
  if (signalCredentials) {
    // Signal contacts sync (phase 2: contacts_dependent - runs after macOS contacts)
    registrations.push({
      syncType: 'signal_contacts',
      syncFn: createSignalContactsSyncFn(options),
    })

    // Signal messages sync (phase 3)
    registrations.push({
      syncType: 'signal',
      syncFn: createSignalSyncFn(options),
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
