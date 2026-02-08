/**
 * Save Twitter/X session cookies via Playwright.
 * Opens a Chromium browser to x.com/i/flow/login, waits for manual login,
 * then saves auth cookies to .cookies.json.
 *
 * Usage: pnpm twitter:save-cookies
 */

import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const COOKIES_PATH = resolve(__dirname, '.cookies.json')

const REQUIRED_COOKIES = ['auth_token', 'ct0']

async function main() {
  console.log('[save-cookies] Launching browser...')

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome', // Use real Chrome instead of Chromium to avoid detection
    args: [
      '--disable-blink-features=AutomationControlled',
    ],
  })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })

  // Remove navigator.webdriver flag that Twitter checks
  const page = await context.newPage()
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })
  await page.goto('https://x.com/i/flow/login')

  console.log('[save-cookies] Please log in to Twitter/X in the browser window...')

  // Wait for navigation to /home (login success) with a generous timeout
  try {
    await page.waitForURL('**/home', { timeout: 300_000 }) // 5 min
  } catch {
    console.error('[save-cookies] Timed out waiting for login. Closing browser.')
    await browser.close()
    process.exit(1)
  }

  // Verify required cookies exist
  const cookies = await context.cookies('https://x.com')
  const cookieMap = new Map(cookies.map((c) => [c.name, c]))

  const missing = REQUIRED_COOKIES.filter((name) => !cookieMap.has(name))
  if (missing.length > 0) {
    console.error(`[save-cookies] Missing required cookies: ${missing.join(', ')}`)
    await browser.close()
    process.exit(1)
  }

  // Save cookies as simplified Cookie[] (matching Twitter API client format)
  const savedCookies = cookies.map((c) => {
    let sameSite: 'Strict' | 'Lax' | 'None' = 'None'
    if (c.sameSite === 'Strict') sameSite = 'Strict'
    else if (c.sameSite === 'Lax') sameSite = 'Lax'

    return {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite,
    }
  })

  writeFileSync(COOKIES_PATH, JSON.stringify(savedCookies, null, 2))
  console.log(`[save-cookies] Saved ${savedCookies.length} cookies to ${COOKIES_PATH}`)

  const authToken = cookieMap.get('auth_token')
  const ct0 = cookieMap.get('ct0')
  console.log(`[save-cookies] auth_token: ${authToken?.value.slice(0, 8)}...`)
  console.log(`[save-cookies] ct0: ${ct0?.value.slice(0, 8)}...`)

  await browser.close()
  console.log('[save-cookies] Done!')
}

main().catch((err) => {
  console.error('[save-cookies] Fatal error:', err)
  process.exit(1)
})
