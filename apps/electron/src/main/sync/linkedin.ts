// LinkedIn scraper for connections data
// Extends SocialScraper base class for persistent browser context

import { SocialScraper } from './social-scraper'

export interface LinkedInConnection {
  name: string
  profileUrl: string
  headline: string | null
  connectedDate: string | null
}

const LINKEDIN_URLS = {
  home: 'https://www.linkedin.com',
  login: 'https://www.linkedin.com/login',
  connections: 'https://www.linkedin.com/mynetwork/invite-connect/connections/',
}

// Selectors for LinkedIn pages
const SELECTORS = {
  // Login detection - presence of feed indicates logged in
  feedContainer: '[data-test-id="feed-container"], .feed-shared-update-v2',
  // Login page elements
  loginForm: 'form.login__form, #organic-div form',
  // Connections page
  connectionsList: '.mn-connections',
  connectionCard: '.mn-connection-card',
  connectionName: '.mn-connection-card__name',
  connectionOccupation: '.mn-connection-card__occupation',
  connectionLink: '.mn-connection-card__link',
  connectionTime: 'time.time-badge',
}

/**
 * LinkedIn scraper for extracting connection data.
 */
export class LinkedInScraper extends SocialScraper {
  constructor() {
    super('linkedin')
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
      const currentUrl = this.page?.url() ?? ''
      return !currentUrl.includes('/login') && !currentUrl.includes('/authwall')
    } catch (error) {
      console.error('Error checking LinkedIn login status:', error)
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
   * Scrape LinkedIn connections.
   * @param headless - Run in headless mode (default: true)
   * @param maxConnections - Maximum connections to scrape (default: 500)
   */
  async scrapeConnections(options: { headless?: boolean; maxConnections?: number } = {}): Promise<
    LinkedInConnection[]
  > {
    const { headless = true, maxConnections = 500 } = options
    const connections: LinkedInConnection[] = []
    const seenUrls = new Set<string>()

    try {
      await this.launchBrowser({ headless })

      // Navigate to connections page
      await this.navigateTo(LINKEDIN_URLS.connections)

      // Wait for connections list to load
      await this.page?.waitForTimeout(2000)

      // Check if we're logged in
      const connectionsList = await this.page?.$(SELECTORS.connectionsList)
      if (!connectionsList) {
        console.error('Not logged in or connections page not accessible')
        return connections
      }

      // Scroll and load connections
      let previousCount = 0
      let noNewConnectionsCount = 0
      const maxNoNewConnections = 3

      while (connections.length < maxConnections && noNewConnectionsCount < maxNoNewConnections) {
        // Parse current visible connection cards
        const newConnections = await this.parseConnectionCards()

        // Add new unique connections (O(1) lookup with Set)
        for (const conn of newConnections) {
          if (!seenUrls.has(conn.profileUrl) && connections.length < maxConnections) {
            seenUrls.add(conn.profileUrl)
            connections.push(conn)
          }
        }

        // Check if we found new connections
        if (connections.length === previousCount) {
          noNewConnectionsCount++
        } else {
          noNewConnectionsCount = 0
        }
        previousCount = connections.length

        // Scroll to load more
        await this.page?.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await this.page?.waitForTimeout(1500)

        console.log(`Scraped ${connections.length} connections...`)
      }

      console.log(`Finished scraping ${connections.length} LinkedIn connections`)
      return connections
    } catch (error) {
      console.error('Error scraping LinkedIn connections:', error)
      return connections
    } finally {
      await this.closeBrowser()
    }
  }

  /**
   * Parse connection cards from the current page.
   */
  private async parseConnectionCards(): Promise<LinkedInConnection[]> {
    if (!this.page) return []

    return await this.page.evaluate((selectors) => {
      const connections: LinkedInConnection[] = []
      const cards = document.querySelectorAll(selectors.connectionCard)

      cards.forEach((card) => {
        try {
          // Get name
          const nameEl = card.querySelector(selectors.connectionName)
          const name = nameEl?.textContent?.trim() ?? ''

          // Get profile URL
          const linkEl = card.querySelector(selectors.connectionLink) as HTMLAnchorElement | null
          const profileUrl = linkEl?.href ?? ''

          // Get headline/occupation
          const occupationEl = card.querySelector(selectors.connectionOccupation)
          const headline = occupationEl?.textContent?.trim() ?? null

          // Get connected date
          const timeEl = card.querySelector(selectors.connectionTime)
          const connectedDate = timeEl?.textContent?.trim() ?? null

          if (name && profileUrl) {
            connections.push({
              name,
              profileUrl: profileUrl.split('?')[0], // Remove query params
              headline,
              connectedDate,
            })
          }
        } catch {
          // Skip malformed cards
        }
      })

      return connections
    }, SELECTORS)
  }
}

// Export singleton instance for convenience
export const linkedInScraper = new LinkedInScraper()
