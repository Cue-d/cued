// LinkedIn scraper for connections data
// Extends SocialScraper base class for persistent browser context

import { SocialScraper } from './social-scraper'
import { LinkedInClient, getConnections } from '../linkedin-api'
import type { Cookie, Connection } from '../linkedin-api'

export interface LinkedInConnection {
  name: string
  profileUrl: string
  headline: string | null
  connectedDate: string | null
}

const LINKEDIN_URLS = {
  home: 'https://www.linkedin.com',
  login: 'https://www.linkedin.com/login',
}

const SELECTORS = {
  feedContainer: '[data-test-id="feed-container"], .feed-shared-update-v2',
  loginForm: 'form.login__form, #organic-div form',
}

/**
 * LinkedIn scraper for extracting connection data.
 */
export class LinkedInScraper extends SocialScraper {
  constructor() {
    super('linkedin')
  }

  /** Cached LinkedInClient instance */
  private _apiClient: LinkedInClient | null = null

  /**
   * Get authentication cookies from the browser context.
   * Must have an active browser session (call launchBrowser first).
   * @returns Promise resolving to Cookie[] for use with LinkedInClient
   */
  async getAuthCookies(): Promise<Cookie[]> {
    if (!this.context) {
      throw new Error('Browser not launched. Call launchBrowser() first.')
    }

    const playwrightCookies = await this.context.cookies()

    const hasLiAt = playwrightCookies.some((c) => c.name === 'li_at')
    const hasJSESSIONID = playwrightCookies.some((c) => c.name === 'JSESSIONID')

    if (!hasLiAt || !hasJSESSIONID) {
      console.warn('[LinkedIn Scraper] Missing critical auth cookies (li_at or JSESSIONID)')
    }

    return playwrightCookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }))
  }

  /**
   * Get a LinkedInClient instance configured with current browser cookies.
   * Creates a new client if needed, or returns cached instance.
   * @param forceRefresh - Force creation of new client with fresh cookies
   * @returns Promise resolving to configured LinkedInClient
   */
  async getApiClient(forceRefresh = false): Promise<LinkedInClient> {
    if (this._apiClient && !forceRefresh) {
      return this._apiClient
    }

    // Ensure browser is launched
    if (!this.context) {
      await this.launchBrowser({ headless: true })
      await this.navigateTo(LINKEDIN_URLS.home)
      await this.page?.waitForTimeout(2000)
    }

    const cookies = await this.getAuthCookies()
    this._apiClient = new LinkedInClient({ cookies })

    if (!this._apiClient.isAuthenticated()) {
      throw new Error('LinkedIn API client not authenticated - missing required cookies')
    }

    return this._apiClient
  }

  /**
   * Check if user is logged in to LinkedIn.
   * Navigates to LinkedIn home and checks for feed presence.
   */
  async checkLoginStatus(): Promise<boolean> {
    try {
      await this.launchBrowser({ headless: true })
      await this.navigateTo(LINKEDIN_URLS.home)

      // Wait a bit for page to load
      await this.page?.waitForTimeout(2000)

      const currentUrl = this.page?.url() ?? ''

      // Check for feed container (indicates logged in)
      const feedElement = await this.page?.$(SELECTORS.feedContainer)
      if (feedElement) {
        return true
      }

      // Check if we're on the login page
      const loginForm = await this.page?.$(SELECTORS.loginForm)
      if (loginForm) {
        return false
      }

      // Check URL - if redirected to login, not logged in
      return !currentUrl.includes('/login') && !currentUrl.includes('/authwall')
    } catch (error) {
      console.error('[LinkedIn Scraper] checkLoginStatus error:', error)
      return false
    } finally {
      await this.closeBrowser()
    }
  }

  /**
   * Open LinkedIn login page in a visible browser for user authentication.
   * Returns when user completes login or closes browser.
   */
  async loginLinkedIn(): Promise<boolean> {
    try {
      // Launch visible browser for user interaction
      await this.launchBrowser({ headless: false })
      await this.navigateTo(LINKEDIN_URLS.login)

      console.log('LinkedIn login page opened. Please log in manually.')

      // Wait for user to complete login (detect feed or timeout)
      const maxWaitMs = 5 * 60 * 1000 // 5 minutes
      const checkIntervalMs = 2000
      const startTime = Date.now()

      while (Date.now() - startTime < maxWaitMs) {
        // Check if we're now on a logged-in page
        const currentUrl = this.page?.url() ?? ''
        if (
          currentUrl.includes('/feed') ||
          currentUrl.includes('/mynetwork') ||
          currentUrl === 'https://www.linkedin.com/'
        ) {
          // Verify with feed element
          const feedElement = await this.page?.$(SELECTORS.feedContainer)
          if (feedElement) {
            console.log('LinkedIn login successful!')
            return true
          }
        }

        // Check if browser was closed
        if (!this.browser?.isConnected() || this.page?.isClosed()) {
          console.log('Browser closed before login completed')
          return false
        }

        await this.page?.waitForTimeout(checkIntervalMs)
      }

      console.log('LinkedIn login timed out')
      return false
    } catch (error) {
      console.error('Error during LinkedIn login:', error)
      return false
    } finally {
      await this.closeBrowser()
    }
  }

  /**
   * Scrape LinkedIn connections using the API.
   * This is more reliable and faster than the Playwright-based approach.
   * @param options.maxConnections - Maximum connections to fetch (default: 500)
   * @returns Promise resolving to Connection[] from the API
   */
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
        cursor = 'cursor' in result ? result.cursor as string | undefined : undefined
        hasMore = cursor !== undefined
      }

      console.log(`[LinkedIn Scraper] Fetched ${allConnections.length} connections`)
      return allConnections
    } catch (error) {
      console.error('[LinkedIn Scraper] Error fetching connections via API:', error)
      return allConnections
    } finally {
      await this.closeBrowser()
    }
  }
}

// Export singleton instance for convenience
export const linkedInScraper = new LinkedInScraper()
