// Twitter/X login webview using Electron BrowserWindow
// Extracts authentication cookies (auth_token, ct0, twid)

import { BrowserWindow, session, safeStorage, app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'
import type { Cookie } from './api'

export interface TwitterLoginResult {
  success: boolean
  cookies?: Cookie[]
  error?: string
}

export interface StoredCookies {
  platform: 'twitter'
  cookies: Cookie[]
  savedAt: number
}

const TWITTER_SESSION_PARTITION = 'twitter-login'
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

const TWITTER_URLS = {
  login: 'https://x.com/i/flow/login',
  home: 'https://x.com/home',
}

function getCookiesPath(): string {
  return join(app.getPath('userData'), 'browser_data', 'twitter_cookies.enc')
}

const LOGGED_IN_PATHS = ['/home', '/messages', '/notifications', '/settings', '/compose']

function isLoggedInUrl(url: string): boolean {
  if (!(url.includes('x.com') || url.includes('twitter.com'))) return false

  if (LOGGED_IN_PATHS.some((path) => url.includes(path))) return true

  try {
    const { pathname } = new URL(url)
    return pathname === '/' || pathname === ''
  } catch {
    return false
  }
}

function isAuthPage(url: string): boolean {
  return (
    url.includes('/login') ||
    url.includes('/i/flow/login') ||
    url.includes('/account/access') ||
    url.includes('/account/login_challenge')
  )
}

function isTwitterCookieDomain(domain: string | undefined): boolean {
  if (!domain) return false
  const d = domain.replace(/^\./, '')
  return d === 'x.com' || d.endsWith('.x.com') || d === 'twitter.com' || d.endsWith('.twitter.com')
}

function hasCookie(cookies: Cookie[], name: string): boolean {
  return cookies.some((c) => c.name === name && c.value)
}

function hasRequiredAuthCookies(cookies: Cookie[]): boolean {
  return hasCookie(cookies, 'auth_token') && hasCookie(cookies, 'ct0')
}

export async function loadStoredCookies(): Promise<Cookie[] | null> {
  if (!safeStorage.isEncryptionAvailable()) {
    console.log('[Twitter Login] Secure storage not available')
    return null
  }

  const cookiesPath = getCookiesPath()
  if (!existsSync(cookiesPath)) {
    console.log('[Twitter Login] No stored cookies found')
    return null
  }

  try {
    const encrypted = readFileSync(cookiesPath)
    const decrypted = safeStorage.decryptString(encrypted)
    const storedCookies: StoredCookies = JSON.parse(decrypted)

    if (Date.now() - storedCookies.savedAt > COOKIE_MAX_AGE_MS) {
      console.log('[Twitter Login] Stored cookies expired, clearing')
      await clearStoredCookies()
      return null
    }

    return storedCookies.cookies
  } catch (error) {
    console.error('[Twitter Login] Failed to load cookies:', error)
    return null
  }
}

export async function storeEncryptedCookies(cookies: Cookie[]): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    console.log('[Twitter Login] Secure storage not available, skipping cookie storage')
    return
  }

  const storedCookies: StoredCookies = {
    platform: 'twitter',
    cookies,
    savedAt: Date.now(),
  }

  const cookiesPath = getCookiesPath()
  mkdirSync(dirname(cookiesPath), { recursive: true })

  const data = JSON.stringify(storedCookies)
  const encrypted = safeStorage.encryptString(data)
  writeFileSync(cookiesPath, encrypted)

  console.log(`[Twitter Login] Stored ${cookies.length} cookies to encrypted file`)
}

export async function clearStoredCookies(): Promise<void> {
  const cookiesPath = getCookiesPath()
  if (existsSync(cookiesPath)) {
    unlinkSync(cookiesPath)
    console.log('[Twitter Login] Cleared stored cookies')
  }
}

export async function clearTwitterSession(): Promise<void> {
  const twitterSession = session.fromPartition(TWITTER_SESSION_PARTITION, { cache: true })

  await twitterSession.clearStorageData({
    storages: ['cookies', 'localstorage'],
  })

  await clearStoredCookies()
  console.log('[Twitter Login] Cleared session and stored cookies')
}

async function extractCookiesFromSession(
  twitterSession: Electron.Session
): Promise<{ cookies: Cookie[]; isAuthenticated: boolean }> {
  const allCookies = await twitterSession.cookies.get({})
  const twitterCookies = allCookies.filter((cookie) => isTwitterCookieDomain(cookie.domain))

  const cookies: Cookie[] = twitterCookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? '.x.com',
    path: cookie.path ?? '/',
    expires: cookie.expirationDate,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite as 'Strict' | 'Lax' | 'None' | undefined,
  }))

  const isAuthenticated = hasRequiredAuthCookies(cookies)
  return { cookies, isAuthenticated }
}

export function openTwitterLogin(): Promise<TwitterLoginResult> {
  return new Promise((resolve) => {
    const twitterSession = session.fromPartition(TWITTER_SESSION_PARTITION, { cache: true })

    const loginWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      title: 'Sign in to X',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: twitterSession,
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

    const attemptExtraction = async (source: string): Promise<boolean> => {
      if (resolved) return true
      if (extractionInProgress) return false

      const url = loginWindow.webContents.getURL()
      console.log(`[Twitter Login] ${source} - URL: ${url}`)

      if (isAuthPage(url)) {
        return false
      }

      if (!isLoggedInUrl(url)) {
        return false
      }

      extractionInProgress = true
      try {
        for (let attempt = 1; attempt <= 3; attempt++) {
          if (resolved) return true

          await new Promise((r) => setTimeout(r, 800))
          const { cookies, isAuthenticated } = await extractCookiesFromSession(twitterSession)

          if (!isAuthenticated) {
            continue
          }

          await storeEncryptedCookies(cookies)

          resolved = true
          cleanup()
          resolve({ success: true, cookies })
          return true
        }

        return false
      } catch (error) {
        console.error('[Twitter Login] Extraction error:', error)
        return false
      } finally {
        extractionInProgress = false
      }
    }

    fallbackInterval = setInterval(async () => {
      if (resolved || loginWindow.isDestroyed()) {
        if (fallbackInterval) clearInterval(fallbackInterval)
        return
      }
      await attemptExtraction('fallback-interval')
    }, 3000)

    loginWindow.webContents.on('did-navigate', async (_event, url) => {
      console.log('[Twitter Login] did-navigate:', url)
      await attemptExtraction('did-navigate')
    })

    loginWindow.webContents.on('did-redirect-navigation', async (_event, url) => {
      console.log('[Twitter Login] did-redirect-navigation:', url)
      await attemptExtraction('did-redirect')
    })

    loginWindow.webContents.on('did-finish-load', async () => {
      await attemptExtraction('did-finish-load')
    })

    loginWindow.webContents.on('dom-ready', async () => {
      await new Promise((r) => setTimeout(r, 300))
      await attemptExtraction('dom-ready')
    })

    console.log('[Twitter Login] Opening login window...')
    loginWindow.loadURL(TWITTER_URLS.login)
  })
}

export async function checkStoredLoginStatus(): Promise<boolean> {
  const cookies = await loadStoredCookies()
  return cookies !== null && hasRequiredAuthCookies(cookies)
}
