// Secure Slack credential storage using Electron's safeStorage API
// Stores xoxc- token and d cookie locally - NEVER uploaded to cloud
// Supports multiple workspaces via per-team credential files

import { safeStorage, app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync } from 'fs'
import { dirname, join } from 'path'

/** Legacy single-workspace file (for migration) */
const LEGACY_CREDENTIALS_FILE = 'slack_credentials.enc'

/** Per-team credential file prefix */
const CREDENTIALS_FILE_PREFIX = 'slack_credentials_'
const CREDENTIALS_FILE_SUFFIX = '.enc'

/** Track if legacy migration has been attempted this session */
let legacyMigrationAttempted = false

export interface SlackStoredCredentials {
  token: string // xoxc- token
  cookie: string // d cookie value
  teamId: string
  teamName: string
  userId: string
  savedAt: number // Unix timestamp when credentials were saved
}

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
