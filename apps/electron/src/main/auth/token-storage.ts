// Secure token storage using Electron's safeStorage API
// safeStorage uses macOS Keychain on macOS, DPAPI on Windows, libsecret on Linux

import { safeStorage, app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'

const TOKENS_FILE = 'auth_tokens.enc'

export interface StoredTokens {
  accessToken: string
  refreshToken: string
  userId: string
  email: string
  firstName: string | null
  lastName: string | null
  expiresAt: number // Unix timestamp in ms
}

function getTokensPath(): string {
  const userDataPath = app.getPath('userData')
  return join(userDataPath, TOKENS_FILE)
}

/**
 * Check if encrypted storage is available.
 * Returns false if OS keychain integration is unavailable.
 */
export function isStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/**
 * Store tokens securely using OS keychain encryption.
 */
export function storeTokens(tokens: StoredTokens): void {
  if (!isStorageAvailable()) {
    throw new Error('Secure storage is not available')
  }

  const tokensPath = getTokensPath()

  // Ensure directory exists
  mkdirSync(dirname(tokensPath), { recursive: true })

  // Encrypt and store
  const data = JSON.stringify(tokens)
  const encrypted = safeStorage.encryptString(data)
  writeFileSync(tokensPath, encrypted)
}

/**
 * Retrieve stored tokens (decrypted).
 * Returns null if no tokens are stored or decryption fails.
 */
export function getStoredTokens(): StoredTokens | null {
  if (!isStorageAvailable()) {
    return null
  }

  const tokensPath = getTokensPath()

  if (!existsSync(tokensPath)) {
    return null
  }

  try {
    const encrypted = readFileSync(tokensPath)
    const decrypted = safeStorage.decryptString(encrypted)
    return JSON.parse(decrypted) as StoredTokens
  } catch {
    // Decryption failed (corrupted or different machine)
    return null
  }
}

/**
 * Check if valid tokens exist.
 */
export function hasValidTokens(): boolean {
  const tokens = getStoredTokens()
  if (!tokens) return false

  // Check if access token is expired (with 5 min buffer)
  const bufferMs = 5 * 60 * 1000
  return tokens.expiresAt > Date.now() + bufferMs
}

/**
 * Clear stored tokens.
 */
export function clearTokens(): void {
  const tokensPath = getTokensPath()
  if (existsSync(tokensPath)) {
    unlinkSync(tokensPath)
  }
}

