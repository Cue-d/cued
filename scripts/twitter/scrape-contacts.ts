/**
 * Scrape Twitter/X followers and following lists via DOM scrolling.
 * Loads saved cookies, navigates to follower/following pages,
 * scrolls through the list, and extracts @handles from rendered user cells.
 *
 * Usage: pnpm twitter:scrape-contacts [screenName]
 * Example: pnpm twitter:scrape-contacts snbafana
 */

import { chromium, type Page } from 'playwright'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const COOKIES_PATH = resolve(__dirname, '.cookies.json')
const CONTACTS_PATH = resolve(__dirname, '.contacts.json')

// ============================================================================
// Types
// ============================================================================

interface Cookie {
  name: string
  value: string
  domain?: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

interface ScrapedUser {
  screenName: string
  name: string
  bio: string | null
}

interface ContactsResult {
  followers: ScrapedUser[]
  following: ScrapedUser[]
  mutuals: ScrapedUser[]
  scrapedAt: string
}

// ============================================================================
// Constants
// ============================================================================

const SCROLL_MIN_PX = 800
const SCROLL_MAX_PX = 1500
const SCROLL_MIN_DELAY_MS = 400
const SCROLL_MAX_DELAY_MS = 900
const MAX_IDLE_SCROLLS = 8
const MAX_USERS_PER_LIST = 5000

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const BROWSER_ARGS = ['--disable-blink-features=AutomationControlled']

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function toPlaywrightCookies(cookies: Cookie[]) {
  return cookies.map((c) => {
    let sameSite: 'Strict' | 'Lax' | 'None' = 'None'
    if (c.sameSite === 'Strict') sameSite = 'Strict'
    else if (c.sameSite === 'Lax') sameSite = 'Lax'

    return {
      name: c.name,
      value: c.value,
      domain: c.domain ?? '.x.com',
      path: c.path ?? '/',
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? true,
      sameSite,
    }
  })
}

// ============================================================================
// DOM extraction — pull @handles from rendered UserCell elements
// ============================================================================

async function extractUsersFromDOM(page: Page): Promise<ScrapedUser[]> {
  return page.evaluate(() => {
    const users: { screenName: string; name: string; bio: string | null }[] = []
    const cells = document.querySelectorAll('[data-testid="UserCell"]')

    for (const cell of cells) {
      let screenName = ''
      let displayName = ''
      let bio: string | null = null

      // 1. @handle — find span text starting with @
      const spans = cell.querySelectorAll('span')
      for (const span of spans) {
        const text = span.textContent?.trim() ?? ''
        if (text.startsWith('@') && /^@[A-Za-z0-9_]+$/.test(text)) {
          screenName = text.slice(1)
          break
        }
      }
      if (!screenName) continue

      // 2. Display name — first profile link's direct text (not the @handle)
      const links = cell.querySelectorAll<HTMLAnchorElement>('a[role="link"]')
      for (const link of links) {
        const href = link.getAttribute('href') ?? ''
        if (href === `/${screenName}`) {
          const linkText = link.textContent?.trim() ?? ''
          if (linkText && !linkText.startsWith('@')) {
            displayName = linkText
            break
          }
        }
      }

      // 3. Bio — look for UserDescription test id, fall back to longer text blocks
      const descEl = cell.querySelector('[data-testid="UserDescription"]')
      if (descEl) {
        bio = descEl.textContent?.trim() || null
      }

      users.push({ screenName, name: displayName || screenName, bio })
    }

    return users
  })
}

// ============================================================================
// Scrape a single list (followers or following) by scrolling
// ============================================================================

async function scrapeList(
  cookies: Cookie[],
  screenName: string,
  listType: 'followers' | 'following'
): Promise<ScrapedUser[]> {
  const tag = `[scrape:${listType}]`
  const users = new Map<string, ScrapedUser>()

  const browser = await chromium.launch({ headless: true, channel: 'chrome', args: BROWSER_ARGS })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, userAgent: USER_AGENT })
  await context.addCookies(toPlaywrightCookies(cookies))

  const page = await context.newPage()
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })

  const url = `https://x.com/${screenName}/${listType}`
  console.log(`${tag} Navigating to ${url}`)

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  } catch (err) {
    console.error(`${tag} Navigation failed:`, err)
    await browser.close()
    return []
  }

  const finalUrl = page.url()
  if (finalUrl.includes('/login') || finalUrl.includes('/i/flow/login')) {
    console.error(`${tag} Redirected to login — cookies may be expired. Re-run save-cookies.`)
    await browser.close()
    return []
  }

  // Wait for initial user cells to render
  try {
    await page.waitForSelector('[data-testid="UserCell"]', { timeout: 15_000 })
  } catch {
    console.error(`${tag} No user cells found — page may not have loaded correctly.`)
    await browser.close()
    return []
  }

  // Scroll loop: keep scrolling until no new handles appear
  let idleScrolls = 0
  let scrollCount = 0

  while (idleScrolls < MAX_IDLE_SCROLLS && users.size < MAX_USERS_PER_LIST) {
    const found = await extractUsersFromDOM(page)
    const before = users.size
    for (const u of found) {
      if (users.size >= MAX_USERS_PER_LIST) break
      const key = u.screenName.toLowerCase()
      if (!users.has(key)) users.set(key, u)
    }
    const added = users.size - before

    if (added > 0) {
      idleScrolls = 0
      console.log(`${tag} Scroll #${scrollCount}: +${added} (total: ${users.size})`)
    } else {
      idleScrolls++
    }

    await page.evaluate((px) => window.scrollBy(0, px), randInt(SCROLL_MIN_PX, SCROLL_MAX_PX))
    scrollCount++
    await sleep(randInt(SCROLL_MIN_DELAY_MS, SCROLL_MAX_DELAY_MS))
  }

  console.log(`${tag} Done: ${users.size} users after ${scrollCount} scrolls`)
  await browser.close()
  return Array.from(users.values())
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const screenName = process.argv[2]
  if (!screenName) {
    console.error('Usage: pnpm twitter:scrape-contacts <screenName>')
    console.error('Example: pnpm twitter:scrape-contacts snbafana')
    process.exit(1)
  }

  if (!existsSync(COOKIES_PATH)) {
    console.error(`[scrape-contacts] No cookies file found at ${COOKIES_PATH}`)
    console.error('[scrape-contacts] Run "pnpm twitter:save-cookies" first.')
    process.exit(1)
  }

  const cookies: Cookie[] = JSON.parse(readFileSync(COOKIES_PATH, 'utf-8'))
  console.log(`[scrape-contacts] Loaded ${cookies.length} cookies`)
  console.log(`[scrape-contacts] Scraping @${screenName}`)

  const following = await scrapeList(cookies, screenName, 'following')
  console.log(`[scrape-contacts] Scraped ${following.length} following`)

  const followers = await scrapeList(cookies, screenName, 'followers')
  console.log(`[scrape-contacts] Scraped ${followers.length} followers`)

  // Compute mutuals
  const followingSet = new Set(following.map((u) => u.screenName.toLowerCase()))
  const mutuals = followers.filter((u) => followingSet.has(u.screenName.toLowerCase()))
  console.log(`[scrape-contacts] Computed ${mutuals.length} mutuals`)

  const result: ContactsResult = {
    followers,
    following,
    mutuals,
    scrapedAt: new Date().toISOString(),
  }

  writeFileSync(CONTACTS_PATH, JSON.stringify(result, null, 2))
  console.log(`[scrape-contacts] Saved to ${CONTACTS_PATH}`)
  console.log(
    `[scrape-contacts] Summary: ${followers.length} followers, ${following.length} following, ${mutuals.length} mutuals`
  )
}

main().catch((err) => {
  console.error('[scrape-contacts] Fatal error:', err)
  process.exit(1)
})
