// Auth Manager - coordinates device authorization and token lifecycle

import {
  deviceAuthorizationFlow,
  TokenResponse,
} from './workos-device'
import {
  storeTokens,
  getStoredTokens,
  hasValidTokens,
  clearTokens,
  StoredTokens,
} from './token-storage'

const REFRESH_ENDPOINT = 'https://api.workos.com/user_management/authenticate'

export interface AuthState {
  isAuthenticated: boolean
  user: {
    id: string
    email: string
    name: string | null
  } | null
}

export interface AuthCallbacks {
  onUserCode?: (code: string, uri: string) => void
  onAuthSuccess?: (user: AuthState['user']) => void
  onAuthError?: (error: string) => void
}

let currentClientId: string | null = null

/**
 * Initialize the auth manager with WorkOS client ID.
 */
export function initAuth(clientId: string): void {
  currentClientId = clientId
}

/**
 * Get the current auth state.
 */
export function getAuthState(): AuthState {
  const tokens = getStoredTokens()
  if (!tokens || !hasValidTokens()) {
    return { isAuthenticated: false, user: null }
  }

  return {
    isAuthenticated: true,
    user: {
      id: tokens.userId,
      email: tokens.email,
      name: tokens.name,
    },
  }
}

/**
 * Get a valid access token, refreshing if necessary.
 */
export async function getValidAccessToken(): Promise<string | null> {
  const tokens = getStoredTokens()
  if (!tokens) return null

  // Check if access token is still valid (with 5 min buffer)
  const bufferMs = 5 * 60 * 1000
  if (tokens.expiresAt > Date.now() + bufferMs) {
    return tokens.accessToken
  }

  // Try to refresh
  if (tokens.refreshToken) {
    try {
      const newTokens = await refreshAccessToken(tokens.refreshToken)
      return newTokens.accessToken
    } catch {
      // Refresh failed, user needs to re-authenticate
      return null
    }
  }

  return null
}

/**
 * Refresh the access token using the refresh token.
 */
async function refreshAccessToken(refreshToken: string): Promise<StoredTokens> {
  if (!currentClientId) {
    throw new Error('Auth not initialized')
  }

  const response = await fetch(REFRESH_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: currentClientId,
    }),
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error_description || error.error || 'Token refresh failed')
  }

  const data = (await response.json()) as TokenResponse
  const storedTokens = tokenResponseToStoredTokens(data)
  storeTokens(storedTokens)

  return storedTokens
}

/**
 * Start the device authorization flow.
 * Opens browser for user to authenticate.
 */
export async function startDeviceAuth(callbacks?: AuthCallbacks): Promise<void> {
  if (!currentClientId) {
    throw new Error('Auth not initialized. Call initAuth(clientId) first.')
  }

  try {
    const tokens = await deviceAuthorizationFlow(currentClientId, {
      onUserCode: callbacks?.onUserCode,
    })

    const storedTokens = tokenResponseToStoredTokens(tokens)
    storeTokens(storedTokens)

    if (callbacks?.onAuthSuccess) {
      callbacks.onAuthSuccess({
        id: storedTokens.userId,
        email: storedTokens.email,
        name: storedTokens.name,
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Authentication failed'
    if (callbacks?.onAuthError) {
      callbacks.onAuthError(message)
    }
    throw error
  }
}

/**
 * Sign out and clear stored tokens.
 */
export function signOut(): void {
  clearTokens()
}

/**
 * Convert WorkOS token response to storage format.
 */
function tokenResponseToStoredTokens(response: TokenResponse): StoredTokens {
  const { first_name, last_name } = response.user
  const name = first_name ? [first_name, last_name].filter(Boolean).join(' ') : null

  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    userId: response.user.id,
    email: response.user.email,
    name,
    expiresAt: Date.now() + response.expires_in * 1000,
  }
}
