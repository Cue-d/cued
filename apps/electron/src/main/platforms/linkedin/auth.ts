// LinkedIn login webview using Electron BrowserWindow
// Extracts authentication cookies (li_at, JSESSIONID) from session

import { BrowserWindow, session, safeStorage, app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'
import type { Cookie } from './api/types'

export interface LinkedInLoginResult {
  success: boolean
  cookies?: Cookie[]
  error?: string
}

export interface StoredCookies {
  platform: 'linkedin'
  cookies: Cookie[]
  savedAt: number
}

const LINKEDIN_SESSION_PARTITION = 'linkedin-login'
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

const LINKEDIN_URLS = {
  login: 'https://www.linkedin.com/login',
  home: 'https://www.linkedin.com',
}

function getCookiesPath(): string {
  return join(app.getPath('userData'), 'browser_data', 'linkedin_cookies.enc')
}

function isStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/** Check if URL indicates user is logged in (any LinkedIn page that's not auth-related) */
function isLoggedInUrl(url: string): boolean {
  // Must be a LinkedIn URL
  if (!url.includes('linkedin.com')) return false

  // Explicit logged-in pages
  if (
    url.includes('/feed') ||
    url.includes('/mynetwork') ||
    url.includes('/messaging') ||
    url.includes('/in/') ||
    url.includes('/jobs') ||
    url.includes('/notifications')
  ) {
    return true
  }

  // Home page without path is logged in
  const parsed = new URL(url)
  if (parsed.pathname === '/' || parsed.pathname === '') {
    return true
  }

  return false
}

/** Check if URL is a login/auth page */
function isAuthPage(url: string): boolean {
  return url.includes('/login') || url.includes('/authwall') || url.includes('/checkpoint')
}

/** Check if cookies contain required auth tokens (li_at and JSESSIONID) */
function hasRequiredAuthCookies(cookies: Cookie[]): boolean {
  const hasLiAt = cookies.some((c) => c.name === 'li_at' && c.value)
  const hasJSESSIONID = cookies.some((c) => c.name === 'JSESSIONID' && c.value)
  return hasLiAt && hasJSESSIONID
}

/** Load stored cookies from encrypted file. Returns null if missing or expired. */
export async function loadStoredCookies(): Promise<Cookie[] | null> {
  if (!isStorageAvailable()) {
    console.log('[LinkedIn Login] Secure storage not available')
    return null
  }

  const cookiesPath = getCookiesPath()
  if (!existsSync(cookiesPath)) {
    console.log('[LinkedIn Login] No stored cookies found')
    return null
  }

  try {
    const encrypted = readFileSync(cookiesPath)
    const decrypted = safeStorage.decryptString(encrypted)
    const storedCookies: StoredCookies = JSON.parse(decrypted)

    // Check if cookies are expired
    if (Date.now() - storedCookies.savedAt > COOKIE_MAX_AGE_MS) {
      console.log('[LinkedIn Login] Stored cookies expired, clearing')
      await clearStoredCookies()
      return null
    }

    console.log(`[LinkedIn Login] Loaded ${storedCookies.cookies.length} cookies from storage`)
    return storedCookies.cookies
  } catch (error) {
    console.error('[LinkedIn Login] Failed to load cookies:', error)
    return null
  }
}

export async function storeEncryptedCookies(cookies: Cookie[]): Promise<void> {
  if (!isStorageAvailable()) {
    console.log('[LinkedIn Login] Secure storage not available, skipping cookie storage')
    return
  }

  const storedCookies: StoredCookies = {
    platform: 'linkedin',
    cookies,
    savedAt: Date.now(),
  }

  const cookiesPath = getCookiesPath()
  mkdirSync(dirname(cookiesPath), { recursive: true })

  const data = JSON.stringify(storedCookies)
  const encrypted = safeStorage.encryptString(data)
  writeFileSync(cookiesPath, encrypted)

  console.log(`[LinkedIn Login] Stored ${cookies.length} cookies to encrypted file`)
}

export async function clearStoredCookies(): Promise<void> {
  const cookiesPath = getCookiesPath()
  if (existsSync(cookiesPath)) {
    unlinkSync(cookiesPath)
    console.log('[LinkedIn Login] Cleared stored cookies')
  }
}

/** Clear LinkedIn session cookies from Electron partition and stored encrypted file */
export async function clearLinkedInSession(): Promise<void> {
  const linkedInSession = session.fromPartition(LINKEDIN_SESSION_PARTITION, { cache: true })

  await linkedInSession.clearStorageData({
    storages: ['cookies', 'localstorage'],
  })

  await clearStoredCookies()
  console.log('[LinkedIn Login] Cleared session and stored cookies')
}

async function extractCookiesFromSession(
  linkedInSession: Electron.Session
): Promise<{ cookies: Cookie[]; isAuthenticated: boolean }> {
  const sessionCookies = await linkedInSession.cookies.get({ domain: '.linkedin.com' })

  const cookies: Cookie[] = sessionCookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain ?? '.linkedin.com',
    path: c.path ?? '/',
    expires: c.expirationDate,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite as 'Strict' | 'Lax' | 'None' | undefined,
  }))

  const isAuthenticated = hasRequiredAuthCookies(cookies)
  console.log(`[LinkedIn Login] Extracted ${cookies.length} cookies, authenticated: ${isAuthenticated}`)

  return { cookies, isAuthenticated }
}

/** Open LinkedIn login BrowserWindow. Returns cookies on success or error on cancellation. */
export function openLinkedInLogin(): Promise<LinkedInLoginResult> {
  return new Promise((resolve) => {
    // Create a dedicated session to isolate LinkedIn cookies
    const linkedInSession = session.fromPartition(LINKEDIN_SESSION_PARTITION, { cache: true })

    const loginWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      title: 'Sign in to LinkedIn',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: linkedInSession,
      },
    })

    let resolved = false
    let extractionInProgress = false
    let fallbackInterval: NodeJS.Timeout | null = null

    const cleanup = () => {
      if (fallbackInterval) {
        clearInterval(fallbackInterval)
        fallbackInterval = null
      }
      if (!loginWindow.isDestroyed()) {
        loginWindow.destroy()
      }
    }

    // Handle window close (user cancelled)
    loginWindow.on('closed', () => {
      if (fallbackInterval) {
        clearInterval(fallbackInterval)
        fallbackInterval = null
      }
      if (!resolved) {
        resolved = true
        resolve({ success: false, error: 'Login cancelled by user' })
      }
    })

    // Helper to attempt credential extraction
    const attemptExtraction = async (source: string): Promise<boolean> => {
      if (resolved) return true
      if (extractionInProgress) {
        console.log(`[LinkedIn Login] ${source} - Extraction already in progress, skipping`)
        return false
      }

      const url = loginWindow.webContents.getURL()
      console.log(`[LinkedIn Login] ${source} - URL: ${url}`)

      // Skip if still on auth page
      if (isAuthPage(url)) {
        console.log('[LinkedIn Login] Still on auth page, skipping extraction')
        return false
      }

      // Check if on a logged-in URL
      if (!isLoggedInUrl(url)) {
        console.log('[LinkedIn Login] Not a logged-in URL, skipping extraction')
        return false
      }

      extractionInProgress = true

      try {
        // Try multiple times with shorter delays
        for (let attempt = 1; attempt <= 3; attempt++) {
          if (resolved) return true

          console.log(`[LinkedIn Login] Extraction attempt ${attempt}/3...`)
          await new Promise((r) => setTimeout(r, 800))

          try {
            const { cookies, isAuthenticated } = await extractCookiesFromSession(linkedInSession)

            if (!isAuthenticated) {
              console.log(`[LinkedIn Login] Attempt ${attempt} - Missing required auth cookies`)
              continue
            }

            // Success! Store cookies and resolve
            console.log('[LinkedIn Login] Success! Storing cookies and closing window...')
            await storeEncryptedCookies(cookies)

            resolved = true
            cleanup()

            resolve({
              success: true,
              cookies,
            })
            return true
          } catch (error) {
            console.error(`[LinkedIn Login] Attempt ${attempt} error:`, error)
          }
        }

        console.log('[LinkedIn Login] All extraction attempts failed, keeping window open')
        return false
      } finally {
        extractionInProgress = false
      }
    }

    // Periodic fallback check in case navigation events miss the login
    fallbackInterval = setInterval(async () => {
      if (resolved || loginWindow.isDestroyed()) {
        if (fallbackInterval) clearInterval(fallbackInterval)
        return
      }
      await attemptExtraction('fallback-interval')
    }, 3000)

    // Monitor navigation to detect successful login
    loginWindow.webContents.on('did-navigate', async (_event, url) => {
      console.log('[LinkedIn Login] did-navigate:', url)
      await attemptExtraction('did-navigate')
    })

    // Also check on redirects (LinkedIn uses many redirects during login)
    loginWindow.webContents.on('did-redirect-navigation', async (_event, url) => {
      console.log('[LinkedIn Login] did-redirect-navigation:', url)
      await attemptExtraction('did-redirect')
    })

    // Also check on page load completion
    loginWindow.webContents.on('did-finish-load', async () => {
      console.log('[LinkedIn Login] did-finish-load:', loginWindow.webContents.getURL())
      await attemptExtraction('did-finish-load')
    })

    // Also check when DOM is ready
    loginWindow.webContents.on('dom-ready', async () => {
      console.log('[LinkedIn Login] dom-ready:', loginWindow.webContents.getURL())
      await new Promise((r) => setTimeout(r, 300))
      await attemptExtraction('dom-ready')
    })

    // Load the LinkedIn login page
    console.log('[LinkedIn Login] Opening login window...')
    loginWindow.loadURL(LINKEDIN_URLS.login)
  })
}

/** Check if user is logged in by verifying stored cookies (does not open browser) */
export async function checkStoredLoginStatus(): Promise<boolean> {
  const cookies = await loadStoredCookies()
  return cookies !== null && hasRequiredAuthCookies(cookies)
}
