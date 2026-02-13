/**
 * Auth utilities for error detection and retry handling
 */

// ============================================================================
// Auth Error Detection
// ============================================================================

const AUTH_ERROR_PATTERNS = [
  // Generic OAuth/HTTP errors
  'unauthorized',
  'unauthenticated',
  '401',
  '403',
  'invalid_token',
  'token expired',
  'token_expired',

  // WorkOS/Convex specific
  'invalidauthheader',
  'could not validate token',

  // Slack specific
  'invalid_auth',
  'not_authed',
  'account_inactive',

  // LinkedIn specific
  'expired_token',
  'invalid_access_token',
] as const

/**
 * Check if an error indicates an authentication failure.
 * Works with Error objects, strings, or objects with message/code properties.
 */
export function isAuthError(error: unknown): boolean {
  // Handle Error objects
  if (error instanceof Error) {
    const message = error.message.toLowerCase()
    if (AUTH_ERROR_PATTERNS.some(p => message.includes(p))) {
      return true
    }
    // Check for Slack-specific error properties
    if ('slackError' in error && typeof error.slackError === 'string') {
      const slackError = error.slackError.toLowerCase()
      if (AUTH_ERROR_PATTERNS.some(p => slackError.includes(p))) {
        return true
      }
    }
    return false
  }

  // Handle string errors
  if (typeof error === 'string') {
    const lower = error.toLowerCase()
    return AUTH_ERROR_PATTERNS.some(p => lower.includes(p))
  }

  // Handle objects with message or code properties
  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>
    if (typeof obj.message === 'string') {
      const lower = obj.message.toLowerCase()
      if (AUTH_ERROR_PATTERNS.some(p => lower.includes(p))) {
        return true
      }
    }
    if (typeof obj.code === 'string') {
      const lower = obj.code.toLowerCase()
      if (AUTH_ERROR_PATTERNS.some(p => lower.includes(p))) {
        return true
      }
    }
    if (typeof obj.error === 'string') {
      const lower = obj.error.toLowerCase()
      if (AUTH_ERROR_PATTERNS.some(p => lower.includes(p))) {
        return true
      }
    }
  }

  return false
}

// ============================================================================
// Auth Retry Wrapper
// ============================================================================

export interface AuthRetryOptions {
  /** Function to get a valid token (with optional force refresh) */
  getValidToken: (forceRefresh?: boolean) => Promise<string | null>
  /** Callback when auth is invalid after retry */
  onAuthInvalid?: () => void
  /** Max retry attempts (default: 1) */
  maxRetries?: number
}

/**
 * Wrap an async function with automatic auth retry.
 *
 * On auth error:
 * 1. Force refresh the token
 * 2. Retry the operation once
 * 3. If still failing, call onAuthInvalid and throw
 *
 * @param fn - Async function that may throw auth errors
 * @param options - Retry configuration
 * @returns Result of fn
 */
export async function withAuthRetry<T>(
  fn: () => Promise<T>,
  options: AuthRetryOptions
): Promise<T> {
  const maxRetries = options.maxRetries ?? 1

  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Ensure we have a valid token before each attempt
      if (attempt > 0) {
        // Force refresh on retry
        const token = await options.getValidToken(true)
        if (!token) {
          options.onAuthInvalid?.()
          throw new Error('Token refresh failed')
        }
      }

      return await fn()
    } catch (error) {
      lastError = error

      // If not an auth error, don't retry
      if (!isAuthError(error)) {
        throw error
      }

      // If we've exhausted retries, give up
      if (attempt >= maxRetries) {
        options.onAuthInvalid?.()
        throw error
      }

      // Will retry with force refresh
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError
}
