/**
 * Unified Sync Runner
 *
 * Simple function that runs all platform syncs sequentially.
 * No orchestrator/manager complexity - just a single runAllSyncs() function.
 */

import { syncContactsToConvex } from '../platforms/contacts/sync'
import {
  getLinkedInSyncManager,
  LinkedInScraper,
} from '../platforms/linkedin'
import {
  getSlackSyncManager,
  getAllSlackSyncManagers,
  getAllSlackCredentials,
} from '../platforms/slack'
import { getIMessageSyncManager } from '../platforms/imessage'
import { createSyncGuard } from './guard'

// Global sync guard to prevent concurrent runAllSyncs calls
const globalSyncGuard = createSyncGuard()

// ============================================================================
// Types
// ============================================================================

export interface RunAllSyncsOptions {
  /** Function to get a valid auth token */
  getAuthToken: (forceRefresh?: boolean) => Promise<string | null>
  /** Optional LinkedIn scraper instance (if already initialized) */
  linkedInScraper?: LinkedInScraper
}

export interface RunAllSyncsResult {
  success: boolean
  skipped?: boolean
  error?: string
  platforms: {
    contacts?: { synced: number; updated: number }
    linkedin?: { contacts: number; messages: number }
    slack?: { messages: number }
    imessage?: { messages: number }
  }
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Run all platform syncs sequentially.
 *
 * Order:
 * 1. macOS Contacts (if available)
 * 2. LinkedIn contacts + messages (if connected)
 * 3. Slack messages (all connected workspaces)
 * 4. iMessage messages
 *
 * Uses a global guard to prevent concurrent runs.
 */
export async function runAllSyncs(options: RunAllSyncsOptions): Promise<RunAllSyncsResult> {
  if (!globalSyncGuard.tryStart()) {
    console.log('[runAllSyncs] Already running, skipping')
    return { success: false, skipped: true, platforms: {} }
  }

  const result: RunAllSyncsResult = { success: true, platforms: {} }

  try {
    // ========================================================================
    // 1. macOS Contacts
    // ========================================================================
    try {
      console.log('[runAllSyncs] Syncing macOS Contacts...')
      const contactsResult = await syncContactsToConvex(options.getAuthToken)
      result.platforms.contacts = {
        synced: contactsResult.contactsCount,
        updated: contactsResult.updatedCount,
      }
      console.log(
        `[runAllSyncs] macOS Contacts: ${contactsResult.contactsCount} synced, ${contactsResult.updatedCount} updated`
      )
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('[runAllSyncs] macOS Contacts sync failed:', msg)
      // Continue with other syncs
    }

    // ========================================================================
    // 2. LinkedIn (if connected)
    // ========================================================================
    try {
      const linkedInScraper = options.linkedInScraper ?? new LinkedInScraper()
      const isLinkedInLoggedIn = await linkedInScraper.checkLoginStatus()

      if (isLinkedInLoggedIn) {
        console.log('[runAllSyncs] Syncing LinkedIn...')

        // Sync LinkedIn contacts (incremental)
        const initialized = await linkedInScraper.initializeForContactsSync()
        let contactsCount = 0
        if (initialized) {
          const scrapeResult = await linkedInScraper.scrapeConnectionsIncremental()
          contactsCount = scrapeResult.connections.length
          console.log(
            `[runAllSyncs] LinkedIn contacts: ${contactsCount} new (hitAnchor: ${scrapeResult.hitAnchor})`
          )
        }

        // Sync LinkedIn messages
        const linkedInSync = getLinkedInSyncManager()
        if (linkedInSync.client) {
          await linkedInSync.runSync()
        }

        const linkedInProgress = linkedInSync.getProgress()
        result.platforms.linkedin = {
          contacts: contactsCount,
          messages: linkedInProgress.totalMessagesSynced,
        }
        console.log(
          `[runAllSyncs] LinkedIn messages: ${linkedInProgress.totalMessagesSynced} synced`
        )
      } else {
        console.log('[runAllSyncs] LinkedIn not connected, skipping')
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('[runAllSyncs] LinkedIn sync failed:', msg)
      // Continue with other syncs
    }

    // ========================================================================
    // 3. Slack (all connected workspaces)
    // ========================================================================
    try {
      const slackCredentials = getAllSlackCredentials()
      if (slackCredentials.length > 0) {
        console.log(`[runAllSyncs] Syncing Slack (${slackCredentials.length} workspace(s))...`)

        let totalSlackMessages = 0
        for (const creds of slackCredentials) {
          try {
            const manager = getSlackSyncManager({ teamId: creds.teamId })
            if (manager.hasCredentials()) {
              await manager.runSync()
              totalSlackMessages += manager.getProgress().totalMessagesSynced
            }
          } catch (workspaceError) {
            const msg = workspaceError instanceof Error ? workspaceError.message : String(workspaceError)
            console.warn(`[runAllSyncs] Slack workspace ${creds.teamId} sync failed:`, msg)
          }
        }

        result.platforms.slack = { messages: totalSlackMessages }
        console.log(`[runAllSyncs] Slack: ${totalSlackMessages} messages synced`)
      } else {
        console.log('[runAllSyncs] No Slack workspaces connected, skipping')
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('[runAllSyncs] Slack sync failed:', msg)
      // Continue with other syncs
    }

    // ========================================================================
    // 4. iMessage
    // ========================================================================
    try {
      console.log('[runAllSyncs] Syncing iMessage...')
      const iMessageManager = getIMessageSyncManager()
      await iMessageManager.runSync()

      const iMessageProgress = iMessageManager.getProgress()
      result.platforms.imessage = { messages: iMessageProgress.totalMessagesSynced }
      console.log(`[runAllSyncs] iMessage: ${iMessageProgress.totalMessagesSynced} messages synced`)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('[runAllSyncs] iMessage sync failed:', msg)
    }

    console.log('[runAllSyncs] All syncs complete')
    return result
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[runAllSyncs] Fatal error:', msg)
    return {
      success: false,
      error: msg,
      platforms: result.platforms,
    }
  } finally {
    globalSyncGuard.finish()
  }
}

/**
 * Check if runAllSyncs is currently running.
 */
export function isRunAllSyncsRunning(): boolean {
  return globalSyncGuard.isRunning()
}
