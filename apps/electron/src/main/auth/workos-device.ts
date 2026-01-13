// WorkOS Device Authorization Flow for Electron
// Based on RFC 8628 (OAuth 2.0 Device Authorization Grant)

import { shell } from 'electron'

const WORKOS_API_BASE = 'https://api.workos.com/user_management'
const DEVICE_AUTH_ENDPOINT = `${WORKOS_API_BASE}/authorize/device`
const TOKEN_ENDPOINT = `${WORKOS_API_BASE}/authenticate`

export interface DeviceAuthorizationResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

export interface TokenResponse {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
  user: {
    id: string
    email: string
    first_name: string | null
    last_name: string | null
  }
}

export interface AuthError {
  error: string
  error_description?: string
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'success'; tokens: TokenResponse }
  | { status: 'slow_down'; newInterval: number }
  | { status: 'error'; error: string; description?: string }

/**
 * Request device authorization from WorkOS.
 * Returns codes for user verification and device polling.
 */
export async function requestDeviceAuthorization(
  clientId: string
): Promise<DeviceAuthorizationResponse> {
  const response = await fetch(DEVICE_AUTH_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: clientId,
    }),
  })

  if (!response.ok) {
    const error = (await response.json()) as AuthError
    throw new Error(error.error_description || error.error || 'Failed to request device authorization')
  }

  return response.json() as Promise<DeviceAuthorizationResponse>
}

/**
 * Poll the token endpoint once for authorization completion.
 */
export async function pollTokenEndpoint(
  clientId: string,
  deviceCode: string
): Promise<PollResult> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: clientId,
    }),
  })

  const data = await response.json()

  if (response.ok) {
    return { status: 'success', tokens: data as TokenResponse }
  }

  const error = data as AuthError

  switch (error.error) {
    case 'authorization_pending':
      return { status: 'pending' }
    case 'slow_down':
      return { status: 'slow_down', newInterval: 10 } // Increase interval
    case 'access_denied':
    case 'expired_token':
      return { status: 'error', error: error.error, description: error.error_description }
    default:
      return { status: 'error', error: error.error || 'unknown_error', description: error.error_description }
  }
}

/**
 * Complete the device authorization flow.
 * Opens browser for user verification and polls until complete or timeout.
 */
export async function deviceAuthorizationFlow(
  clientId: string,
  options?: { onUserCode?: (code: string, uri: string) => void; signal?: AbortSignal }
): Promise<TokenResponse> {
  // Step 1: Request device authorization
  const auth = await requestDeviceAuthorization(clientId)

  // Step 2: Notify caller of user code (for display)
  if (options?.onUserCode) {
    options.onUserCode(auth.user_code, auth.verification_uri)
  }

  // Step 3: Open browser for user to authenticate
  await shell.openExternal(auth.verification_uri_complete)

  // Step 4: Poll for completion
  let interval = auth.interval * 1000 // Convert to milliseconds
  const expiresAt = Date.now() + auth.expires_in * 1000

  while (Date.now() < expiresAt) {
    // Check for abort signal
    if (options?.signal?.aborted) {
      throw new Error('Authorization cancelled')
    }

    // Wait for interval
    await new Promise((resolve) => setTimeout(resolve, interval))

    // Poll token endpoint
    const result = await pollTokenEndpoint(clientId, auth.device_code)

    switch (result.status) {
      case 'success':
        return result.tokens
      case 'pending':
        continue
      case 'slow_down':
        interval = result.newInterval * 1000
        continue
      case 'error':
        throw new Error(result.description || result.error)
    }
  }

  throw new Error('Authorization timed out')
}
