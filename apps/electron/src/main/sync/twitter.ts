// X (Twitter) scraper for followers/following data
// Extends SocialScraper base class for persistent browser context

import { SocialScraper } from './social-scraper'

export interface TwitterUser {
  displayName: string
  handle: string // @username without the @
  bio: string | null
  profileUrl: string
}

const TWITTER_URLS = {
  home: 'https://x.com/home',
  login: 'https://x.com/login',
  followers: (username: string) => `https://x.com/${username}/followers`,
  following: (username: string) => `https://x.com/${username}/following`,
}

// Selectors for X/Twitter pages
const SELECTORS = {
  // Login detection - presence of home timeline indicates logged in
  homeTimeline: '[data-testid="primaryColumn"]',
  tweetArticle: 'article[data-testid="tweet"]',
  // Login page elements
  loginForm: '[data-testid="loginButton"], [data-testid="LoginForm_Login_Button"]',
  // User cards in followers/following lists
  userCell: '[data-testid="UserCell"]',
  userNameLink: '[data-testid="UserCell"] a[role="link"]',
  displayName: '[data-testid="UserCell"] [dir="ltr"] > span',
  userHandle: '[data-testid="UserCell"] [dir="ltr"][class*="r-"]',
  userBio: '[data-testid="UserCell"] [data-testid="UserDescription"]',
}

/**
 * X (Twitter) scraper for extracting followers/following data.
 */
export class TwitterScraper extends SocialScraper {
  constructor() {
    super('twitter')
  }

  /**
   * Check if user is logged in to X/Twitter.
   * Navigates to X home and checks for timeline presence.
   */
  async checkLoginStatus(): Promise<boolean> {
    try {
      await this.launchBrowser({ headless: true })
      await this.navigateTo(TWITTER_URLS.home)

      // Wait for page to load
      await this.page?.waitForTimeout(3000)

      // Check for home timeline (indicates logged in)
      const timeline = await this.page?.$(SELECTORS.homeTimeline)
      if (timeline) {
        // Verify we can see tweets (not just the column)
        const tweet = await this.page?.$(SELECTORS.tweetArticle)
        if (tweet) {
          return true
        }
      }

      // Check URL - if redirected to login, not logged in
      const currentUrl = this.page?.url() ?? ''
      return !currentUrl.includes('/login') && !currentUrl.includes('/i/flow/login')
    } catch (error) {
      console.error('Error checking Twitter login status:', error)
      return false
    } finally {
      await this.closeBrowser()
    }
  }

  /**
   * Open X/Twitter login page in a visible browser for user authentication.
   * Returns when user completes login or closes browser.
   */
  async loginTwitter(): Promise<boolean> {
    try {
      // Launch visible browser for user interaction
      await this.launchBrowser({ headless: false })
      await this.navigateTo(TWITTER_URLS.login)

      console.log('X/Twitter login page opened. Please log in manually.')

      // Wait for user to complete login (detect home timeline or timeout)
      const maxWaitMs = 5 * 60 * 1000 // 5 minutes
      const checkIntervalMs = 2000
      const startTime = Date.now()

      while (Date.now() - startTime < maxWaitMs) {
        // Check if we're now on the home page
        const currentUrl = this.page?.url() ?? ''
        if (currentUrl.includes('/home') || currentUrl === 'https://x.com/') {
          // Verify with timeline element
          const timeline = await this.page?.$(SELECTORS.homeTimeline)
          if (timeline) {
            console.log('X/Twitter login successful!')
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

      console.log('X/Twitter login timed out')
      return false
    } catch (error) {
      console.error('Error during X/Twitter login:', error)
      return false
    } finally {
      await this.closeBrowser()
    }
  }

  /**
   * Scrape followers for a given username.
   * @param username - Twitter username (without @)
   * @param options - Scraping options
   */
  async scrapeFollowers(
    username: string,
    options: { headless?: boolean; maxUsers?: number } = {}
  ): Promise<TwitterUser[]> {
    return this.scrapeUserList(TWITTER_URLS.followers(username), options)
  }

  /**
   * Scrape following for a given username.
   * @param username - Twitter username (without @)
   * @param options - Scraping options
   */
  async scrapeFollowing(
    username: string,
    options: { headless?: boolean; maxUsers?: number } = {}
  ): Promise<TwitterUser[]> {
    return this.scrapeUserList(TWITTER_URLS.following(username), options)
  }

  /**
   * Get mutual followers/following (intersection).
   * @param username - Twitter username (without @)
   * @param options - Scraping options
   */
  async getMutuals(
    username: string,
    options: { headless?: boolean; maxUsers?: number } = {}
  ): Promise<TwitterUser[]> {
    console.log(`Scraping followers for @${username}...`)
    const followers = await this.scrapeFollowers(username, options)
    const followerHandles = new Set(followers.map((u) => u.handle))

    console.log(`Scraping following for @${username}...`)
    const following = await this.scrapeFollowing(username, options)

    // Find intersection - users who are both followers and following
    const mutuals = following.filter((u) => followerHandles.has(u.handle))

    console.log(
      `Found ${mutuals.length} mutuals (${followers.length} followers, ${following.length} following)`
    )
    return mutuals
  }

  /**
   * Scrape a user list page (followers or following).
   */
  private async scrapeUserList(
    url: string,
    options: { headless?: boolean; maxUsers?: number } = {}
  ): Promise<TwitterUser[]> {
    const { headless = true, maxUsers = 500 } = options
    const users: TwitterUser[] = []
    const seenHandles = new Set<string>()

    try {
      await this.launchBrowser({ headless })

      // Navigate to the user list page
      await this.navigateTo(url)

      // Wait for page to load
      await this.page?.waitForTimeout(2000)

      // Check if we're logged in by looking for user cells
      const firstCell = await this.page?.$(SELECTORS.userCell)
      if (!firstCell) {
        // Check if we're on login page
        const currentUrl = this.page?.url() ?? ''
        if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
          console.error('Not logged in to X/Twitter')
          return users
        }
        // May be an empty list or protected account
        console.warn('No user cells found - may be empty list or protected account')
        return users
      }

      // Scroll and load users
      let previousCount = 0
      let noNewUsersCount = 0
      const maxNoNewUsers = 3

      while (users.length < maxUsers && noNewUsersCount < maxNoNewUsers) {
        // Parse current visible user cards
        const newUsers = await this.parseUserCards()

        // Add new unique users (O(1) lookup with Set)
        for (const user of newUsers) {
          if (!seenHandles.has(user.handle) && users.length < maxUsers) {
            seenHandles.add(user.handle)
            users.push(user)
          }
        }

        // Check if we found new users
        if (users.length === previousCount) {
          noNewUsersCount++
        } else {
          noNewUsersCount = 0
        }
        previousCount = users.length

        // Scroll to load more
        await this.page?.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await this.page?.waitForTimeout(1500)

        console.log(`Scraped ${users.length} users...`)
      }

      console.log(`Finished scraping ${users.length} users from ${url}`)
      return users
    } catch (error) {
      console.error('Error scraping Twitter user list:', error)
      return users
    } finally {
      await this.closeBrowser()
    }
  }

  /**
   * Parse user cards from the current page.
   */
  private async parseUserCards(): Promise<TwitterUser[]> {
    if (!this.page) return []

    return await this.page.evaluate((selectors) => {
      const users: TwitterUser[] = []
      const cells = document.querySelectorAll(selectors.userCell)

      cells.forEach((cell) => {
        try {
          // Get profile link to extract handle
          const linkEl = cell.querySelector('a[role="link"][href^="/"]') as HTMLAnchorElement | null
          const href = linkEl?.href ?? ''
          const handleMatch = href.match(/x\.com\/([^/?]+)/)
          const handle = handleMatch?.[1] ?? ''

          // Skip if no handle or if it's a reserved path
          if (!handle || ['home', 'explore', 'notifications', 'messages', 'i'].includes(handle)) {
            return
          }

          // Get display name - usually the first text span in the cell
          const nameSpans = Array.from(cell.querySelectorAll('[dir="ltr"] > span'))
          let displayName = ''
          for (const span of nameSpans) {
            const text = span.textContent?.trim() ?? ''
            if (text && !text.startsWith('@')) {
              displayName = text
              break
            }
          }

          // Get bio if available
          const bioEl = cell.querySelector('[data-testid="UserDescription"]')
          const bio = bioEl?.textContent?.trim() ?? null

          if (handle && displayName) {
            users.push({
              displayName,
              handle,
              bio,
              profileUrl: `https://x.com/${handle}`,
            })
          }
        } catch {
          // Skip malformed cards
        }
      })

      return users
    }, SELECTORS)
  }
}

// Export singleton instance for convenience
export const twitterScraper = new TwitterScraper()
