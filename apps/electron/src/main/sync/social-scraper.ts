// Social scraper base class for persistent browser automation
// Uses Playwright with persistent browser contexts for session management

import { chromium, Browser, BrowserContext, Page } from 'playwright'
import { safeStorage, app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'

export type SocialPlatform = 'linkedin' | 'twitter'

export interface StoredCookies {
  platform: SocialPlatform
  cookies: Array<{
    name: string
    value: string
    domain: string
    path: string
    expires?: number
    httpOnly?: boolean
    secure?: boolean
    sameSite?: 'Strict' | 'Lax' | 'None'
  }>
  savedAt: number
}

/**
 * Base class for social platform scrapers.
 * Manages persistent browser contexts and secure cookie storage.
 */
export abstract class SocialScraper {
  protected platform: SocialPlatform
  protected browser: Browser | null = null
  protected context: BrowserContext | null = null
  protected page: Page | null = null

  constructor(platform: SocialPlatform) {
    this.platform = platform
  }

  /**
   * Get the path to store browser profile data.
   */
  protected getBrowserDataPath(): string {
    const userDataPath = app.getPath('userData')
    return join(userDataPath, 'browser_data', this.platform)
  }

  /**
   * Get the path to store encrypted cookies.
   */
  protected getCookiesPath(): string {
    const userDataPath = app.getPath('userData')
    return join(userDataPath, 'browser_data', `${this.platform}_cookies.enc`)
  }

  /**
   * Check if secure storage is available.
   */
  protected isStorageAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  /**
   * Store cookies securely using Electron safeStorage.
   */
  protected async storeCookies(): Promise<void> {
    if (!this.context || !this.isStorageAvailable()) {
      return
    }

    const cookies = await this.context.cookies()
    const storedCookies: StoredCookies = {
      platform: this.platform,
      cookies: cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      })),
      savedAt: Date.now(),
    }

    const cookiesPath = this.getCookiesPath()
    mkdirSync(dirname(cookiesPath), { recursive: true })

    const data = JSON.stringify(storedCookies)
    const encrypted = safeStorage.encryptString(data)
    writeFileSync(cookiesPath, encrypted)
  }

  /**
   * Load stored cookies into the browser context.
   */
  protected async loadCookies(): Promise<boolean> {
    if (!this.context || !this.isStorageAvailable()) {
      return false
    }

    const cookiesPath = this.getCookiesPath()
    if (!existsSync(cookiesPath)) {
      return false
    }

    try {
      const encrypted = readFileSync(cookiesPath)
      const decrypted = safeStorage.decryptString(encrypted)
      const storedCookies: StoredCookies = JSON.parse(decrypted)

      // Check if cookies are too old (7 days)
      const maxAgeMs = 7 * 24 * 60 * 60 * 1000
      if (Date.now() - storedCookies.savedAt > maxAgeMs) {
        this.clearCookies()
        return false
      }

      await this.context.addCookies(storedCookies.cookies)
      return true
    } catch {
      return false
    }
  }

  /**
   * Clear stored cookies.
   */
  protected clearCookies(): void {
    const cookiesPath = this.getCookiesPath()
    if (existsSync(cookiesPath)) {
      unlinkSync(cookiesPath)
    }
  }

  /**
   * Launch browser with persistent context.
   * Reuses existing context if available.
   */
  async launchBrowser(options: { headless?: boolean } = {}): Promise<Page> {
    const { headless = false } = options

    // Reuse existing page if browser is still connected
    if (this.browser?.isConnected() && this.page && !this.page.isClosed()) {
      return this.page
    }

    // Clean up any stale resources
    await this.closeBrowser()

    const browserDataPath = this.getBrowserDataPath()
    mkdirSync(browserDataPath, { recursive: true })

    // Launch browser with persistent context
    this.browser = await chromium.launch({
      headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    })

    // Create persistent context with user data directory
    this.context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
    })

    // Load any stored cookies
    await this.loadCookies()

    this.page = await this.context.newPage()
    return this.page
  }

  /**
   * Close browser and save cookies.
   */
  async closeBrowser(): Promise<void> {
    // Save cookies before closing
    if (this.context) {
      try {
        await this.storeCookies()
      } catch (e) {
        console.error('Failed to store cookies:', e)
      }
    }

    // Close page
    if (this.page && !this.page.isClosed()) {
      try {
        await this.page.close()
      } catch {
        // Page may already be closed
      }
    }
    this.page = null

    // Close context
    if (this.context) {
      try {
        await this.context.close()
      } catch {
        // Context may already be closed
      }
    }
    this.context = null

    // Close browser
    if (this.browser?.isConnected()) {
      try {
        await this.browser.close()
      } catch {
        // Browser may already be closed
      }
    }
    this.browser = null
  }

  /**
   * Navigate to a URL and wait for load.
   * Uses 'domcontentloaded' instead of 'networkidle' for social sites
   * that have continuous background network activity.
   */
  protected async navigateTo(url: string, options: { timeout?: number } = {}): Promise<void> {
    if (!this.page) {
      throw new Error('Browser not launched. Call launchBrowser() first.')
    }
    await this.page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeout ?? 60000
    })
  }

  /**
   * Wait for an element to appear.
   */
  protected async waitForSelector(
    selector: string,
    options: { timeout?: number } = {}
  ): Promise<void> {
    if (!this.page) {
      throw new Error('Browser not launched. Call launchBrowser() first.')
    }
    await this.page.waitForSelector(selector, { timeout: options.timeout ?? 30000 })
  }

  /**
   * Scroll to bottom of page with delay for lazy loading.
   */
  protected async scrollToBottom(options: { delay?: number; maxScrolls?: number } = {}): Promise<void> {
    if (!this.page) {
      throw new Error('Browser not launched. Call launchBrowser() first.')
    }

    const { delay = 1000, maxScrolls = 50 } = options
    let lastHeight = 0
    let scrollCount = 0

    while (scrollCount < maxScrolls) {
      const currentHeight = await this.page.evaluate(() => document.body.scrollHeight)
      if (currentHeight === lastHeight) break

      await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await this.page.waitForTimeout(delay)

      lastHeight = currentHeight
      scrollCount++
    }
  }

  /**
   * Check if user is logged in to the platform.
   * Must be implemented by subclasses.
   */
  abstract checkLoginStatus(): Promise<boolean>
}
