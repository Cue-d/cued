// LinkedIn scraper for connections data
// Uses Electron BrowserWindow for login, then API for data fetching

import { ConvexHttpClient } from 'convex/browser'
import { api } from '@prm/convex'
import {
  openLinkedInLogin,
  loadStoredCookies,
  checkStoredLoginStatus,
  clearLinkedInSession,
} from './auth'
import { LinkedInClient, getConnections } from './api'
import type { Cookie, Connection } from './api'
import {
  createConvexClient,
  loadCursor,
  saveCursor,
  clearCursor,
  setConvexAuth,
} from '../../sync/cursor'

// ============================================================================
// Contacts Cursor Types
// ============================================================================

/** An anchor connection for cursor-based incremental sync */
interface ConnectionAnchor {
  profileId: string
  name: string
}

/** Cursor state for LinkedIn contacts sync stored in Convex */
interface ContactsCursorState {
  /** First 5 connections from last sync - used as anchors to detect new connections */
  anchorConnections: ConnectionAnchor[]
}

/** Result of an incremental contacts scrape */
export interface IncrementalScrapeResult {
  /** New connections fetched since last sync */
  connections: Connection[]
  /** Whether we hit an anchor (found a previously synced connection) */
  hitAnchor: boolean
  /** Number of API pages fetched */
  pagesFetched: number
}

/** Maximum anchor connections to track */
const MAX_ANCHORS = 5

export interface LinkedInConnection {
  name: string
  profileUrl: string
  headline: string | null
  connectedDate: string | null
  /** LinkedIn profile ID (URN ID portion) for matching with messaging contacts */
  profileId?: string
}

/** LinkedIn scraper for extracting connection data using stored cookies */
export class LinkedInScraper {
  private _apiClient: LinkedInClient | null = null
  private convexClient: ConvexHttpClient | null = null

  /** Get a LinkedInClient instance, creating one if needed or if forceRefresh is true */
  async getApiClient(forceRefresh = false): Promise<LinkedInClient> {
    if (this._apiClient && !forceRefresh) {
      return this._apiClient
    }

    const cookies = await loadStoredCookies()
    if (!cookies) {
      throw new Error('No stored cookies. User must log in first.')
    }

    this._apiClient = new LinkedInClient({ cookies })

    if (!this._apiClient.isAuthenticated()) {
      throw new Error('LinkedIn API client not authenticated - missing required cookies')
    }

    return this._apiClient
  }

  /** Check if user is logged in (via stored cookies, does not open browser) */
  async checkLoginStatus(): Promise<boolean> {
    return checkStoredLoginStatus()
  }

  /** Open LinkedIn login BrowserWindow for user authentication */
  async loginLinkedIn(): Promise<boolean> {
    const result = await openLinkedInLogin()

    if (result.success && result.cookies) {
      this._apiClient = new LinkedInClient({ cookies: result.cookies })
      return true
    }

    return false
  }

  /** Clear stored LinkedIn session and cookies */
  async logout(): Promise<void> {
    await clearLinkedInSession()
    this._apiClient = null
  }

  /** Scrape LinkedIn connections using the API */
  async scrapeConnectionsViaApi(options: { maxConnections?: number } = {}): Promise<Connection[]> {
    const { maxConnections } = options
    const allConnections: Connection[] = []

    try {
      const client = await this.getApiClient()

      let cursor: string | undefined
      let hasMore = true

      while (hasMore && (maxConnections === undefined || allConnections.length < maxConnections)) {
        const result = await getConnections(client, cursor)

        if (result.connections.length === 0) {
          break
        }

        for (const conn of result.connections) {
          if (maxConnections !== undefined && allConnections.length >= maxConnections) {
            break
          }
          allConnections.push(conn)
        }

        // Use cursor from result to determine if there are more pages
        cursor = 'cursor' in result ? (result.cursor as string | undefined) : undefined
        hasMore = cursor !== undefined
      }

      return allConnections
    } catch (error) {
      console.error('[LinkedIn Scraper] Error fetching connections via API:', error)
      return allConnections
    }
  }

  // ============================================================================
  // Incremental Contacts Sync (Cursor-based)
  // ============================================================================

  /**
   * Initialize for contacts sync - sets up Convex client with auth.
   * Must be called before scrapeConnectionsIncremental().
   *
   * @returns true if authenticated, false otherwise
   */
  async initializeForContactsSync(): Promise<boolean> {
    if (!this.convexClient) {
      this.convexClient = createConvexClient()
    }

    const token = await setConvexAuth(this.convexClient)
    if (!token) {
      console.warn('[LinkedIn Scraper] Not authenticated for contacts sync')
      return false
    }

    return true
  }

  /**
   * Scrape LinkedIn connections incrementally using anchor-based cursor.
   *
   * Behavior:
   * - Loads cursor from Convex (5 anchor connections from last sync)
   * - Paginates through connections (sorted RECENTLY_ADDED)
   * - Stops when ANY anchor is matched (found existing connection)
   * - Saves first 5 new connections as new anchors
   *
   * @param options.maxPages - Maximum pages to fetch (default: 50)
   * @returns New connections since last sync
   */
  async scrapeConnectionsIncremental(
    options: { maxPages?: number } = {}
  ): Promise<IncrementalScrapeResult> {
    const { maxPages = 50 } = options

    if (!this.convexClient) {
      throw new Error('Must call initializeForContactsSync() first')
    }

    // Load cursor from Convex
    const cursor = await loadCursor<ContactsCursorState>(this.convexClient, 'linkedin')
    const anchorSet = new Set(cursor?.cursorData.anchorConnections.map((a) => a.profileId) ?? [])
    const hasAnchors = anchorSet.size > 0

    console.log(
      `[LinkedIn Scraper] Starting incremental scrape, anchors: ${anchorSet.size}, hasAnchors: ${hasAnchors}`
    )

    const newConnections: Connection[] = []
    let hitAnchor = false
    let pagesFetched = 0

    try {
      const client = await this.getApiClient()
      let apiCursor: string | undefined

      while (pagesFetched < maxPages) {
        const result = await getConnections(client, apiCursor)
        pagesFetched++

        if (result.connections.length === 0) {
          break
        }

        // Process connections, stop if we hit an anchor
        for (const conn of result.connections) {
          if (hasAnchors && anchorSet.has(conn.profileId)) {
            console.log(
              `[LinkedIn Scraper] Hit anchor: ${conn.profileId} (${conn.firstName} ${conn.lastName})`
            )
            hitAnchor = true
            break
          }
          newConnections.push(conn)
        }

        if (hitAnchor) {
          break
        }

        // Check for more pages
        apiCursor = 'cursor' in result ? (result.cursor as string | undefined) : undefined
        if (!apiCursor) {
          break
        }
      }

      // Save new anchors (first 5 connections from this sync)
      await this.saveContactsCursor(newConnections, cursor?.cursorData.anchorConnections)

      console.log(
        `[LinkedIn Scraper] Incremental scrape complete: ${newConnections.length} new connections, ${pagesFetched} pages, hitAnchor: ${hitAnchor}`
      )

      return {
        connections: newConnections,
        hitAnchor,
        pagesFetched,
      }
    } catch (error) {
      console.error('[LinkedIn Scraper] Error in incremental scrape:', error)
      return {
        connections: newConnections,
        hitAnchor,
        pagesFetched,
      }
    }
  }

  /**
   * Clear the contacts cursor to force a full re-scrape.
   */
  async clearContactsCursor(): Promise<void> {
    if (!this.convexClient) {
      this.convexClient = createConvexClient()
    }

    const token = await setConvexAuth(this.convexClient)
    if (!token) {
      console.warn('[LinkedIn Scraper] Not authenticated to clear contacts cursor')
      return
    }

    await clearCursor(this.convexClient, 'linkedin')
    console.log('[LinkedIn Scraper] Contacts cursor cleared')
  }

  /**
   * Save contacts cursor to Convex.
   * Stores first 5 connections as anchors for next incremental sync.
   */
  private async saveContactsCursor(
    newConnections: Connection[],
    previousAnchors?: ConnectionAnchor[]
  ): Promise<void> {
    if (!this.convexClient) return

    // Build new anchors from new connections (first MAX_ANCHORS)
    const newAnchors: ConnectionAnchor[] = newConnections.slice(0, MAX_ANCHORS).map((conn) => ({
      profileId: conn.profileId,
      name: `${conn.firstName} ${conn.lastName}`.trim(),
    }))

    // If we have fewer than MAX_ANCHORS, supplement with previous anchors
    if (newAnchors.length < MAX_ANCHORS && previousAnchors) {
      const remaining = MAX_ANCHORS - newAnchors.length
      const existingIds = new Set(newAnchors.map((a) => a.profileId))
      for (const prev of previousAnchors) {
        if (newAnchors.length >= MAX_ANCHORS) break
        if (!existingIds.has(prev.profileId)) {
          newAnchors.push(prev)
        }
      }
    }

    const cursorData: ContactsCursorState = {
      anchorConnections: newAnchors,
    }

    await saveCursor(this.convexClient, 'linkedin', cursorData, {
      syncMode: 'incremental',
    })

    console.log(`[LinkedIn Scraper] Saved ${newAnchors.length} anchors to cursor`)
  }
}
