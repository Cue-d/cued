/**
 * Slack Authentication Module
 *
 * Combines:
 * - Browser-based login flow (BrowserWindow for xoxc- token extraction)
 * - Secure credential storage (OS keychain encryption)
 *
 * Supports multiple workspaces via per-team credential files.
 */

import { BrowserWindow, session, safeStorage, app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync } from 'fs'
import { dirname, join } from 'path'

// ============================================================================
// Types
// ============================================================================

export interface SlackLoginResult {
  success: boolean
  credentials?: {
    token: string // xoxc- token
    cookie: string // d cookie value
    teamId: string
    teamName: string
    userId: string
  }
  error?: string
}

export interface SlackStoredCredentials {
  token: string // xoxc- token
  cookie: string // d cookie value
  teamId: string
  teamName: string
  userId: string
  savedAt: number // Unix timestamp when credentials were saved
}

// ============================================================================
// Constants
// ============================================================================

/** Legacy single-workspace file (for migration) */
const LEGACY_CREDENTIALS_FILE = 'slack_credentials.enc'

/** Per-team credential file prefix */
const CREDENTIALS_FILE_PREFIX = 'slack_credentials_'
const CREDENTIALS_FILE_SUFFIX = '.enc'

/** Track if legacy migration has been attempted this session */
let legacyMigrationAttempted = false

const SLACK_URLS = {
  signIn: 'https://slack.com/signin',
  workspace: 'https://app.slack.com',
}

// Token extraction script to run in browser context
const EXTRACT_TOKEN_SCRIPT = `
  (function() {
    try {
      // Extract token from localStorage.localConfig_v2
      const localConfig = localStorage.getItem('localConfig_v2');
      if (!localConfig) return { error: 'No localConfig_v2 found' };

      const config = JSON.parse(localConfig);

      // Find the first team with a token
      const teams = config.teams || {};
      const teamIds = Object.keys(teams);

      if (teamIds.length === 0) return { error: 'No teams found in config' };

      const teamId = teamIds[0];
      const team = teams[teamId];

      if (!team || !team.token) return { error: 'No token found for team' };

      // Token should start with xoxc-
      if (!team.token.startsWith('xoxc-')) {
        return { error: 'Token does not start with xoxc-' };
      }

      return {
        token: team.token,
        teamId: teamId,
        teamName: team.name || teamId,
        userId: team.user_id || ''
      };
    } catch (e) {
      return { error: 'Failed to parse localStorage: ' + e.message };
    }
  })()
`

// ============================================================================
// Credential Storage (OS Keychain)
// ============================================================================

/**
 * Get path to credential file for a specific team.
 */
function getCredentialsPath(teamId: string): string {
  const userDataPath = app.getPath('userData')
  return join(userDataPath, `${CREDENTIALS_FILE_PREFIX}${teamId}${CREDENTIALS_FILE_SUFFIX}`)
}

/**
 * Get path to legacy single-workspace credential file.
 */
function getLegacyCredentialsPath(): string {
  const userDataPath = app.getPath('userData')
  return join(userDataPath, LEGACY_CREDENTIALS_FILE)
}

/**
 * Check if encrypted storage is available.
 */
export function isSlackStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/**
 * Migrate legacy single-workspace credentials to per-team format.
 * Called automatically by getAllSlackCredentials() (once per session).
 */
function migrateLegacyCredentials(): void {
  // Only attempt migration once per session
  if (legacyMigrationAttempted) return
  legacyMigrationAttempted = true

  if (!isSlackStorageAvailable()) return

  const legacyPath = getLegacyCredentialsPath()
  if (!existsSync(legacyPath)) return

  try {
    const encrypted = readFileSync(legacyPath)
    const decrypted = safeStorage.decryptString(encrypted)
    const credentials = JSON.parse(decrypted) as SlackStoredCredentials

    if (credentials.teamId) {
      // Save to new per-team file
      const newPath = getCredentialsPath(credentials.teamId)
      writeFileSync(newPath, encrypted)
      console.log(`[Slack Credentials] Migrated legacy credentials to per-team file for ${credentials.teamName}`)

      // Only remove legacy file after successful write
      unlinkSync(legacyPath)
      console.log('[Slack Credentials] Removed legacy credentials file')
    }
  } catch (error) {
    console.error('[Slack Credentials] Failed to migrate legacy credentials:', error)
  }
}

/**
 * Save Slack credentials securely using OS keychain encryption.
 * On macOS this uses Keychain, Windows uses DPAPI, Linux uses libsecret.
 * Supports multiple workspaces - each team's credentials are stored separately.
 */
export function saveSlackCredentials(credentials: Omit<SlackStoredCredentials, 'savedAt'>): void {
  if (!isSlackStorageAvailable()) {
    throw new Error('Secure storage is not available')
  }

  const credentialsPath = getCredentialsPath(credentials.teamId)

  // Ensure directory exists
  mkdirSync(dirname(credentialsPath), { recursive: true })

  const storedCredentials: SlackStoredCredentials = {
    ...credentials,
    savedAt: Date.now(),
  }

  // Encrypt and store
  const data = JSON.stringify(storedCredentials)
  const encrypted = safeStorage.encryptString(data)
  writeFileSync(credentialsPath, encrypted)

  console.log(`[Slack Credentials] Saved credentials for team: ${credentials.teamName} (${credentials.teamId})`)
}

/**
 * Retrieve stored Slack credentials for a specific team (decrypted).
 * Returns null if no credentials are stored or decryption fails.
 */
export function getSlackCredentials(teamId?: string): SlackStoredCredentials | null {
  if (!isSlackStorageAvailable()) {
    return null
  }

  // If no teamId specified, return first available (for backward compatibility)
  if (!teamId) {
    const all = getAllSlackCredentials()
    return all.length > 0 ? all[0] : null
  }

  const credentialsPath = getCredentialsPath(teamId)

  if (!existsSync(credentialsPath)) {
    return null
  }

  try {
    const encrypted = readFileSync(credentialsPath)
    const decrypted = safeStorage.decryptString(encrypted)
    return JSON.parse(decrypted) as SlackStoredCredentials
  } catch (error) {
    console.error(`[Slack Credentials] Failed to decrypt credentials for ${teamId}:`, error)
    return null
  }
}

/**
 * Get all stored Slack workspace credentials.
 * Returns an array of credentials for all connected workspaces.
 */
export function getAllSlackCredentials(): SlackStoredCredentials[] {
  if (!isSlackStorageAvailable()) {
    return []
  }

  // Migrate legacy credentials if they exist
  migrateLegacyCredentials()

  const userDataPath = app.getPath('userData')
  const credentials: SlackStoredCredentials[] = []

  try {
    const files = readdirSync(userDataPath)
    for (const file of files) {
      if (file.startsWith(CREDENTIALS_FILE_PREFIX) && file.endsWith(CREDENTIALS_FILE_SUFFIX)) {
        const filePath = join(userDataPath, file)
        try {
          const encrypted = readFileSync(filePath)
          const decrypted = safeStorage.decryptString(encrypted)
          const creds = JSON.parse(decrypted) as SlackStoredCredentials
          credentials.push(creds)
        } catch (error) {
          console.error(`[Slack Credentials] Failed to read ${file}:`, error)
        }
      }
    }
  } catch (error) {
    console.error('[Slack Credentials] Failed to list credential files:', error)
  }

  // Sort by savedAt descending (most recently added first)
  credentials.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))

  return credentials
}

/**
 * Check if any Slack credentials exist.
 */
export function hasSlackCredentials(): boolean {
  return getAllSlackCredentials().length > 0
}

/**
 * Check if credentials exist for a specific team.
 */
export function hasSlackCredentialsForTeam(teamId: string): boolean {
  return getSlackCredentials(teamId) !== null
}

/**
 * Clear stored Slack credentials for a specific team.
 */
export function clearSlackCredentials(teamId?: string): void {
  if (!teamId) {
    // Clear all credentials (backward compatibility)
    const all = getAllSlackCredentials()
    for (const creds of all) {
      deleteSlackCredentials(creds.teamId)
    }
    return
  }

  deleteSlackCredentials(teamId)
}

/**
 * Delete credentials for a specific team.
 */
export function deleteSlackCredentials(teamId: string): void {
  const credentialsPath = getCredentialsPath(teamId)
  if (existsSync(credentialsPath)) {
    unlinkSync(credentialsPath)
    console.log(`[Slack Credentials] Cleared credentials for team: ${teamId}`)
  }
}

/**
 * Validate that stored credentials appear to be valid format.
 * Does NOT make network calls - just checks format.
 */
export function validateSlackCredentials(
  credentials: SlackStoredCredentials | null
): credentials is SlackStoredCredentials {
  if (!credentials) return false

  // Token should start with xoxc-
  if (!credentials.token.startsWith('xoxc-')) {
    console.warn('[Slack Credentials] Token does not start with xoxc-')
    return false
  }

  // Cookie should be a non-empty string
  if (!credentials.cookie || credentials.cookie.length === 0) {
    console.warn('[Slack Credentials] Cookie is empty')
    return false
  }

  // TeamId should be non-empty
  if (!credentials.teamId || credentials.teamId.length === 0) {
    console.warn('[Slack Credentials] TeamId is empty')
    return false
  }

  return true
}

// ============================================================================
// Browser Login Flow
// ============================================================================

/**
 * Check if URL indicates user is logged into a workspace.
 * Matches patterns like:
 * - https://app.slack.com/client/T123/...
 * - https://myworkspace.slack.com/...
 * - https://app.slack.com/...
 */
function isWorkspaceUrl(url: string): boolean {
  // app.slack.com is the main workspace app
  if (url.startsWith(SLACK_URLS.workspace)) {
    return true
  }

  // myworkspace.slack.com pattern (but not slack.com/signin etc)
  const workspacePattern = /^https:\/\/[a-z0-9-]+\.slack\.com\/(client|messages|archives)/i
  return workspacePattern.test(url)
}

/**
 * Open Slack login in a BrowserWindow and wait for user to complete authentication.
 * Returns credentials on success or error on failure/cancellation.
 */
export function openSlackLogin(): Promise<SlackLoginResult> {
  return new Promise((resolve) => {
    // Create a dedicated session to avoid polluting the default session
    const slackSession = session.fromPartition('slack-login', { cache: true })

    const loginWindow = new BrowserWindow({
      width: 1000,
      height: 700,
      title: 'Sign in to Slack',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: slackSession,
      },
    })

    let resolved = false
    let extractionInProgress = false

    const cleanup = () => {
      if (!loginWindow.isDestroyed()) {
        loginWindow.destroy()
      }
    }

    // Handle window close (user cancelled)
    loginWindow.on('closed', () => {
      if (!resolved) {
        resolved = true
        resolve({ success: false, error: 'Login cancelled by user' })
      }
    })

    // Block slack:// deep links that would open the desktop app
    // Instead, navigate to the web workspace
    loginWindow.webContents.on('will-navigate', (event, url) => {
      console.log('[Slack Login] will-navigate:', url)

      if (url.startsWith('slack://')) {
        console.log('[Slack Login] Blocking slack:// deep link, extracting workspace info...')
        event.preventDefault()

        // Parse the deep link to get team/channel info
        // Formats:
        // - slack://TCKE4QSG5/magic-login/... (team ID is first path segment)
        // - slack://channel?team=T123&id=C456
        // - slack://open?team=T123
        try {
          const parsed = new URL(url)

          // First try query param
          let teamId = parsed.searchParams.get('team')

          // If not in query, check if hostname is the team ID (slack://TEAMID/...)
          if (!teamId && parsed.hostname && parsed.hostname.startsWith('T')) {
            teamId = parsed.hostname
          }

          if (teamId) {
            // Navigate to the web workspace instead
            const webUrl = `https://app.slack.com/client/${teamId}`
            console.log('[Slack Login] Redirecting to web workspace:', webUrl)
            loginWindow.loadURL(webUrl)
          } else {
            console.log('[Slack Login] Could not extract team ID from deep link')
          }
        } catch (e) {
          console.error('[Slack Login] Failed to parse deep link:', e)
        }
      }
    })

    // Also handle new window attempts (some links open in new windows)
    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      console.log('[Slack Login] Window open attempt:', url)

      if (url.startsWith('slack://')) {
        console.log('[Slack Login] Blocking slack:// in new window')

        try {
          const parsed = new URL(url)
          let teamId = parsed.searchParams.get('team')
          if (!teamId && parsed.hostname && parsed.hostname.startsWith('T')) {
            teamId = parsed.hostname
          }
          if (teamId) {
            loginWindow.loadURL(`https://app.slack.com/client/${teamId}`)
          }
        } catch (e) {
          console.error('[Slack Login] Failed to parse deep link:', e)
        }

        return { action: 'deny' }
      }

      // Allow other URLs to open in the same window
      loginWindow.loadURL(url)
      return { action: 'deny' }
    })

    // Helper to attempt credential extraction with retries
    // Uses extractionInProgress flag to prevent concurrent extraction attempts
    const attemptExtraction = async (source: string): Promise<boolean> => {
      if (resolved) return true
      if (extractionInProgress) {
        console.log(`[Slack Login] ${source} - Extraction already in progress, skipping`)
        return false
      }

      const url = loginWindow.webContents.getURL()
      console.log(`[Slack Login] ${source} - URL: ${url}`)

      if (!isWorkspaceUrl(url)) {
        console.log('[Slack Login] Not a workspace URL, skipping extraction')
        return false
      }

      // Lock extraction to prevent concurrent attempts
      extractionInProgress = true

      try {
        // Try multiple times with delays - localStorage may take time to populate
        for (let attempt = 1; attempt <= 3; attempt++) {
          if (resolved) return true

          console.log(`[Slack Login] Extraction attempt ${attempt}/3...`)
          await new Promise((r) => setTimeout(r, 1500))

          try {
            const tokenResult = await loginWindow.webContents.executeJavaScript(
              EXTRACT_TOKEN_SCRIPT
            )

            if (tokenResult.error) {
              console.log(`[Slack Login] Attempt ${attempt} - Token extraction failed:`, tokenResult.error)
              continue
            }

            // Extract d cookie from session
            const cookies = await slackSession.cookies.get({ domain: '.slack.com' })
            console.log(`[Slack Login] Found ${cookies.length} cookies for .slack.com`)
            const dCookie = cookies.find((c) => c.name === 'd')

            if (!dCookie) {
              console.log(`[Slack Login] Attempt ${attempt} - d cookie not found`)
              continue
            }

            // Success!
            console.log(`[Slack Login] Success! Team: ${tokenResult.teamName}`)
            resolved = true
            cleanup()

            resolve({
              success: true,
              credentials: {
                token: tokenResult.token,
                cookie: dCookie.value,
                teamId: tokenResult.teamId,
                teamName: tokenResult.teamName,
                userId: tokenResult.userId,
              },
            })
            return true
          } catch (error) {
            console.error(`[Slack Login] Attempt ${attempt} error:`, error)
          }
        }

        console.log('[Slack Login] All extraction attempts failed, keeping window open')
        return false
      } finally {
        extractionInProgress = false
      }
    }

    // Monitor navigation to detect successful login
    loginWindow.webContents.on('did-navigate', async (_event, url) => {
      console.log('[Slack Login] did-navigate:', url)
      await attemptExtraction('did-navigate')
    })

    // Also check on page load completion
    loginWindow.webContents.on('did-finish-load', async () => {
      console.log('[Slack Login] did-finish-load:', loginWindow.webContents.getURL())
      await attemptExtraction('did-finish-load')
    })

    // Also check when DOM is ready (sometimes fires when did-navigate doesn't)
    loginWindow.webContents.on('dom-ready', async () => {
      console.log('[Slack Login] dom-ready:', loginWindow.webContents.getURL())
      // Small delay to let JS initialize
      await new Promise((r) => setTimeout(r, 500))
      await attemptExtraction('dom-ready')
    })

    // Load the Slack sign-in page
    console.log('[Slack Login] Opening login window...')
    loginWindow.loadURL(SLACK_URLS.signIn)
  })
}

/**
 * Clear Slack session cookies and storage.
 */
export async function clearSlackSession(): Promise<void> {
  const slackSession = session.fromPartition('slack-login', { cache: true })

  await slackSession.clearStorageData({
    storages: ['cookies', 'localstorage'],
  })
}
