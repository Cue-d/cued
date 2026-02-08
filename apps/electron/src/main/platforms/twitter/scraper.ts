// Twitter/X scraper using DOM-based scrolling (no CDP/GraphQL interception).

import { BrowserWindow, session } from 'electron'
import { openTwitterLogin, loadStoredCookies, checkStoredLoginStatus, clearTwitterSession } from './auth'
import { TwitterClient } from './api'

// ============================================================================
// Types
// ============================================================================

export interface ScrapedUser {
  screenName: string
  name: string
  bio: string | null
}

export interface FollowersFollowingResult {
  followers: ScrapedUser[]
  following: ScrapedUser[]
  mutuals: ScrapedUser[]
}

// ============================================================================
// Constants
// ============================================================================

const TWITTER_SESSION_PARTITION = 'twitter-login'
const SCROLL_MIN_PX = 800
const SCROLL_MAX_PX = 1500
const SCROLL_MIN_DELAY_MS = 400
const SCROLL_MAX_DELAY_MS = 900
const MAX_IDLE_SCROLLS = 8
const MAX_USERS_PER_LIST = 5000
/** Stop scrolling after this many consecutive newly-seen users are already known. */
const EARLY_STOP_CONSECUTIVE_KNOWN = 20

// ============================================================================
// TwitterScraper
// ============================================================================

export class TwitterScraper {
  private _apiClient: TwitterClient | null = null

  async getApiClient(forceRefresh = false): Promise<TwitterClient> {
    if (this._apiClient && !forceRefresh) {
      return this._apiClient
    }

    const cookies = await loadStoredCookies()
    if (!cookies) {
      throw new Error('No stored cookies. User must log in first.')
    }

    this._apiClient = new TwitterClient({ cookies })

    if (!this._apiClient.isAuthenticated()) {
      throw new Error('Twitter API client not authenticated - missing required cookies')
    }

    return this._apiClient
  }

  async checkLoginStatus(): Promise<boolean> {
    return checkStoredLoginStatus()
  }

  async loginTwitter(): Promise<boolean> {
    const result = await openTwitterLogin()

    if (result.success && result.cookies) {
      this._apiClient = new TwitterClient({ cookies: result.cookies })
      return true
    }

    return false
  }

  async logout(): Promise<void> {
    await clearTwitterSession()
    this._apiClient = null
  }

  /**
   * Scrape followers and following lists via BrowserWindow + DOM scrolling.
   * Navigates to x.com/{screenName}/following and /followers,
   * scrolls through the rendered page, and extracts @handles from UserCell elements.
   *
   * Pass knownFollowerHandles/knownFollowingHandles to enable early termination —
   * scrolling stops when enough consecutive known handles are encountered.
   */
  async scrapeFollowersFollowing(
    screenName: string,
    options?: {
      knownFollowerHandles?: Set<string>
      knownFollowingHandles?: Set<string>
    }
  ): Promise<FollowersFollowingResult> {
    console.log(`[TwitterScraper] Starting followers/following scrape for @${screenName}`)

    const following = await this.scrapeUserList(screenName, 'following', options?.knownFollowingHandles)
    console.log(`[TwitterScraper] Scraped ${following.length} following`)

    const followers = await this.scrapeUserList(screenName, 'followers', options?.knownFollowerHandles)
    console.log(`[TwitterScraper] Scraped ${followers.length} followers`)

    const followingSet = new Set(following.map((u) => u.screenName.toLowerCase()))
    const mutuals = followers.filter((u) => followingSet.has(u.screenName.toLowerCase()))
    console.log(`[TwitterScraper] Computed ${mutuals.length} mutuals`)

    return { followers, following, mutuals }
  }

  /**
   * Scrape a single user list (followers or following) via DOM scrolling.
   * If knownHandles is provided, stops early after EARLY_STOP_CONSECUTIVE_KNOWN
   * consecutive newly seen users that are already known.
   */
  private async scrapeUserList(
    screenName: string,
    listType: 'followers' | 'following',
    knownHandles?: Set<string>
  ): Promise<ScrapedUser[]> {
    const tag = `[TwitterScraper:${listType}]`
    const twitterSession = session.fromPartition(TWITTER_SESSION_PARTITION, { cache: true })

    const storedCookies = await loadStoredCookies()
    if (storedCookies) {
      console.log(`${tag} Injecting ${storedCookies.length} cookies into session`)
      for (const cookie of storedCookies) {
        try {
          await twitterSession.cookies.set({
            url: `https://${(cookie.domain ?? '.x.com').replace(/^\./, '')}`,
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path ?? '/',
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            sameSite: toElectronSameSite(cookie.sameSite),
          })
        } catch (error) {
          console.warn(`${tag} Failed to set cookie '${cookie.name}':`, error instanceof Error ? error.message : error)
        }
      }
    } else {
      console.warn(`${tag} No stored cookies — scrape will likely fail (unauthenticated)`)
    }

    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: twitterSession,
      },
    })

    const users = new Map<string, ScrapedUser>()

    try {
      const url = `https://x.com/${screenName}/${listType}`
      console.log(`${tag} Navigating to ${url}`)
      await win.loadURL(url)

      const finalUrl = win.webContents.getURL()
      console.log(`${tag} Page loaded: ${finalUrl}`)
      if (finalUrl.includes('/login') || finalUrl.includes('/i/flow/login')) {
        throw new Error(`Twitter ${listType} scrape failed: redirected to login page — session is not authenticated`)
      }

      try {
        await win.webContents.executeJavaScript(`
          new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('timeout')), 15000);
            const check = () => {
              if (document.querySelector('[data-testid="UserCell"]')) {
                clearTimeout(timeout);
                resolve(true);
              } else {
                setTimeout(check, 200);
              }
            };
            check();
          })
        `)
      } catch {
        throw new Error(`Twitter ${listType} scrape failed: no user cells found within timeout — page may not have loaded correctly`)
      }

      // Scroll loop: extract handles from DOM, scroll, repeat
      let idleScrolls = 0
      let scrollCount = 0
      let consecutiveKnownUsers = 0
      let earlyStop = false

      while (idleScrolls < MAX_IDLE_SCROLLS && users.size < MAX_USERS_PER_LIST && !earlyStop) {
        const found: ScrapedUser[] = await win.webContents.executeJavaScript(`
          (() => {
            const users = [];
            const cells = document.querySelectorAll('[data-testid="UserCell"]');
            for (const cell of cells) {
              let screenName = '';
              let displayName = '';
              let bio = null;

              const spans = cell.querySelectorAll('span');
              for (const span of spans) {
                const text = span.textContent?.trim() ?? '';
                if (text.startsWith('@') && /^@[A-Za-z0-9_]+$/.test(text)) {
                  screenName = text.slice(1);
                  break;
                }
              }
              if (!screenName) continue;

              const links = cell.querySelectorAll('a[role="link"]');
              for (const link of links) {
                const href = link.getAttribute('href') ?? '';
                if (href === '/' + screenName) {
                  const linkText = link.textContent?.trim() ?? '';
                  if (linkText && !linkText.startsWith('@')) {
                    displayName = linkText;
                    break;
                  }
                }
              }

              const descEl = cell.querySelector('[data-testid="UserDescription"]');
              if (descEl) bio = descEl.textContent?.trim() || null;

              users.push({ screenName, name: displayName || screenName, bio });
            }
            return users;
          })()
        `)

        // Track which users are genuinely new to this scrape session
        const newlyAdded: ScrapedUser[] = []
        for (const u of found) {
          if (users.size >= MAX_USERS_PER_LIST) break
          const key = u.screenName.toLowerCase()
          if (!users.has(key)) {
            users.set(key, u)
            newlyAdded.push(u)
          }
        }
        const added = newlyAdded.length

        if (added > 0) {
          idleScrolls = 0
          console.log(`${tag} Scroll #${scrollCount}: +${added} (total: ${users.size})`)

          // Early stop: count consecutive newly-discovered users that are already known
          if (knownHandles && knownHandles.size > 0) {
            for (const u of newlyAdded) {
              if (knownHandles.has(u.screenName.toLowerCase())) {
                consecutiveKnownUsers++
              } else {
                consecutiveKnownUsers = 0
              }
            }
            if (consecutiveKnownUsers >= EARLY_STOP_CONSECUTIVE_KNOWN) {
              console.log(`${tag} Early stop: ${consecutiveKnownUsers} consecutive known users`)
              earlyStop = true
            }
          }
        } else {
          idleScrolls++
        }

        const scrollPx = randInt(SCROLL_MIN_PX, SCROLL_MAX_PX)
        await win.webContents.executeJavaScript(`window.scrollBy(0, ${scrollPx})`)
        scrollCount++
        await sleep(randInt(SCROLL_MIN_DELAY_MS, SCROLL_MAX_DELAY_MS))
      }

      console.log(`${tag} Done: ${users.size} users after ${scrollCount} scrolls${earlyStop ? ' (early stop)' : ''}`)
      return Array.from(users.values())
    } finally {
      win.destroy()
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

type ElectronSameSite = 'unspecified' | 'no_restriction' | 'lax' | 'strict'

const SAME_SITE_MAP: Record<string, ElectronSameSite> = {
  none: 'no_restriction',
  lax: 'lax',
  strict: 'strict',
}

function toElectronSameSite(sameSite?: string): ElectronSameSite | undefined {
  if (!sameSite) return undefined
  return SAME_SITE_MAP[sameSite.toLowerCase()] ?? 'unspecified'
}
