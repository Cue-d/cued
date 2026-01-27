// LinkedIn scraper for connections data
// Uses Electron BrowserWindow for login, then API for data fetching

import {
  openLinkedInLogin,
  loadStoredCookies,
  checkStoredLoginStatus,
  clearLinkedInSession,
} from '../auth/linkedin-login'
import { LinkedInClient, getConnections } from '../linkedin-api'
import type { Cookie, Connection } from '../linkedin-api'

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

}
