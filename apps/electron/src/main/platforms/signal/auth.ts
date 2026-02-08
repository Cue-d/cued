/**
 * Signal authentication/config module.
 *
 * Signal uses local signal-cli state; this module stores the selected account
 * and CLI path in encrypted storage for convenience.
 *
 * The connect flow:
 *   1. Check Java 21+ is available
 *   2. Download signal-cli from GitHub releases (if not already installed)
 *   3. Open Terminal.app with `signal-cli link` to display a QR code
 *   4. User scans QR code with Signal mobile app
 *   5. Credentials saved to encrypted storage
 */

import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { SignalClient, checkJavaAvailable, downloadSignalCli, openLinkTerminal } from './client'
import type {
  SignalLoginCredentials,
  SignalLoginResult,
  SignalSetupResult,
  SignalValidationStep,
} from '../../../shared/electron-api'

const CREDENTIALS_FILE = 'signal_credentials.enc'

export interface SignalStoredCredentials {
  account: string
  cliPath?: string
  savedAt: number
}

export type { SignalLoginResult, SignalSetupResult }

function getCredentialsPath(): string {
  return join(app.getPath('userData'), CREDENTIALS_FILE)
}

function getSignalCliInstallDir(): string {
  return join(app.getPath('userData'), 'signal-cli')
}

function getInstalledCliPath(): string {
  return join(getSignalCliInstallDir(), 'bin', 'signal-cli')
}

function getLinkResultFile(): string {
  return join(tmpdir(), 'cued-signal-link-result.txt')
}

/**
 * signal-cli stores data in ~/.local/share/signal-cli/data/ (XDG default).
 * accounts.json contains account number mappings.
 */
function getSignalCliDataDir(): string {
  return join(homedir(), '.local', 'share', 'signal-cli', 'data')
}

function readAccountFromSignalCli(): string | undefined {
  const accountsFile = join(getSignalCliDataDir(), 'accounts.json')
  if (!existsSync(accountsFile)) return undefined

  try {
    const data = JSON.parse(readFileSync(accountsFile, 'utf-8'))
    const accounts = data?.accounts as Array<{ number?: string }> | undefined
    if (accounts && accounts.length > 0) {
      const last = accounts[accounts.length - 1]
      return last?.number || undefined
    }
  } catch (error) {
    console.warn('[Signal Auth] Failed to read accounts.json:', error)
  }
  return undefined
}

export function isSignalStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

export function saveSignalCredentials(
  credentials: Omit<SignalStoredCredentials, 'savedAt'>
): void {
  if (!isSignalStorageAvailable()) {
    throw new Error('Secure storage is not available')
  }

  const path = getCredentialsPath()
  mkdirSync(dirname(path), { recursive: true })

  const payload: SignalStoredCredentials = {
    ...credentials,
    savedAt: Date.now(),
  }

  const encrypted = safeStorage.encryptString(JSON.stringify(payload))
  writeFileSync(path, encrypted)
}

export function getStoredSignalCredentials(): SignalStoredCredentials | null {
  if (!isSignalStorageAvailable()) {
    return null
  }

  const path = getCredentialsPath()
  if (!existsSync(path)) {
    return null
  }

  try {
    const encrypted = readFileSync(path)
    const decrypted = safeStorage.decryptString(encrypted)
    return JSON.parse(decrypted) as SignalStoredCredentials
  } catch (error) {
    console.error('[Signal Auth] Failed to decrypt credentials:', error)
    return null
  }
}

/**
 * Load credentials from encrypted storage, falling back to signal-cli's
 * accounts.json if nothing is persisted yet (e.g. first sync after linking).
 */
export function loadSignalCredentials(): SignalStoredCredentials | null {
  const stored = getStoredSignalCredentials()
  if (stored) return stored

  // Fallback: check if signal-cli is already linked on disk
  const account = readAccountFromSignalCli()
  if (!account) return null

  const installedPath = getInstalledCliPath()
  const cliPath = existsSync(installedPath) ? installedPath : undefined
  const credentials: SignalStoredCredentials = { account, cliPath, savedAt: Date.now() }

  // Persist so subsequent calls hit encrypted storage directly
  try {
    saveSignalCredentials({ account, cliPath })
  } catch (error) {
    console.warn('[Signal Auth] Failed to persist credentials from fallback:', error)
  }

  return credentials
}

export function clearSignalCredentials(): void {
  const path = getCredentialsPath()
  if (existsSync(path)) {
    unlinkSync(path)
  }
}

async function validateSignalCredentials(
  credentials: SignalStoredCredentials | null
): Promise<{ ok: boolean; error?: string }> {
  if (!credentials) {
    return { ok: false, error: 'Signal is not configured. Set SIGNAL_ACCOUNT or connect once.' }
  }

  try {
    const client = new SignalClient({
      account: credentials.account,
      cliPath: credentials.cliPath,
    })
    const available = await client.isAvailable()
    if (!available) {
      return {
        ok: false,
        error: `signal-cli not available (${credentials.cliPath ?? 'signal-cli'})`,
      }
    }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

// ============================================================================
// Setup flow: Java check + signal-cli download
// ============================================================================

/**
 * Check Java and install signal-cli if needed.
 * Returns the path to the usable signal-cli binary.
 */
export async function setupSignalCli(
  credentials?: SignalLoginCredentials
): Promise<SignalSetupResult> {
  const steps: SignalValidationStep[] = [
    { step: 'java', status: 'pending' },
    { step: 'install', status: 'pending' },
    { step: 'link', status: 'pending' },
  ]

  // If user provided a custom CLI path, skip install and just check Java
  const customPath = credentials?.cliPath?.trim()
  if (customPath) {
    // Still check Java
    steps[0]!.status = 'running'
    const java = await checkJavaAvailable()
    if (!java.ok) {
      steps[0]!.status = 'error'
      steps[0]!.error = java.error
      return { success: false, steps, error: java.error }
    }
    steps[0]!.status = 'success'

    // Verify custom path works
    steps[1]!.status = 'running'
    const client = new SignalClient({ account: 'test', cliPath: customPath })
    const available = await client.isAvailable()
    if (!available) {
      steps[1]!.status = 'error'
      steps[1]!.error = `signal-cli not found at "${customPath}"`
      return { success: false, steps, error: steps[1]!.error }
    }
    steps[1]!.status = 'success'
    return { success: true, cliPath: customPath, steps }
  }

  // Check if already installed in app data
  const installedPath = getInstalledCliPath()
  const alreadyInstalled = existsSync(installedPath)

  // Step 1: Java check
  steps[0]!.status = 'running'
  const java = await checkJavaAvailable()
  if (!java.ok) {
    steps[0]!.status = 'error'
    steps[0]!.error = java.error
    return { success: false, steps, error: java.error }
  }
  steps[0]!.status = 'success'

  // Step 2: Download signal-cli if needed
  steps[1]!.status = 'running'
  if (alreadyInstalled) {
    console.log('[Signal Auth] signal-cli already installed at', installedPath)
    steps[1]!.status = 'success'
    return { success: true, cliPath: installedPath, steps }
  }

  try {
    const cliPath = await downloadSignalCli(getSignalCliInstallDir())
    steps[1]!.status = 'success'
    return { success: true, cliPath, steps }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    steps[1]!.status = 'error'
    steps[1]!.error = msg
    return { success: false, steps, error: msg }
  }
}

// ============================================================================
// Link flow: Open Terminal.app for QR code scanning
// ============================================================================

/**
 * Open Terminal.app with signal-cli link and a QR code.
 */
export async function startLinkInTerminal(
  cliPath: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Clean up any previous result file
    const resultFile = getLinkResultFile()
    if (existsSync(resultFile)) {
      unlinkSync(resultFile)
    }
    await openLinkTerminal(cliPath, resultFile)
    return { success: true }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { success: false, error: msg }
  }
}

/**
 * Check if the link process completed by looking for the result file
 * and for accounts in signal-cli's data directory.
 */
export async function checkLinkResult(
  cliPath: string
): Promise<SignalLoginResult> {
  const resultFile = getLinkResultFile()

  if (!existsSync(resultFile)) {
    return { success: false, isLoggedIn: false, error: 'Linking not complete yet' }
  }

  // Read the result — it's either a phone number or "linked"
  const result = readFileSync(resultFile, 'utf-8').trim()

  // Try to find the account: result file may have the number, or read from accounts.json
  let account = result.startsWith('+') ? result : undefined

  if (!account) {
    account = readAccountFromSignalCli()
  }

  if (!account) {
    return {
      success: false,
      isLoggedIn: false,
      error: 'Linking completed but could not determine account number',
    }
  }

  // Save credentials
  try {
    saveSignalCredentials({ account, cliPath })
  } catch (error) {
    console.warn('[Signal Auth] Failed to persist credentials:', error)
  }

  // Clean up result file
  try {
    unlinkSync(resultFile)
  } catch {
    // ignore
  }

  return { success: true, isLoggedIn: true }
}

// ============================================================================
// Status check
// ============================================================================

export async function checkSignalLoginStatus(): Promise<SignalLoginResult> {
  // loadSignalCredentials already falls back to signal-cli's accounts.json
  const credentials = loadSignalCredentials()

  const status = await validateSignalCredentials(credentials)
  return {
    success: status.ok,
    isLoggedIn: status.ok,
    error: status.error,
  }
}

