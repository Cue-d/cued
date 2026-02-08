/**
 * Twitter API error handling helpers.
 */

export interface TwitterErrorItem {
  message?: string
  code?: number
}

export interface TwitterErrorsPayload {
  errors?: TwitterErrorItem[]
}

export class TwitterApiError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public code?: number
  ) {
    super(message)
    this.name = 'TwitterApiError'
  }
}

export const TWITTER_ERROR_CODES = {
  pageNotFound: 34,
  couldNotAuthenticate: 32,
  suspended: 63,
  ratelimitExceeded: 88,
  notActive: 141,
  accountTemporarilyLocked: 326,
  csrfMismatch: 353,
} as const

const AUTH_ERROR_CODES = new Set<number>([
  TWITTER_ERROR_CODES.couldNotAuthenticate,
  TWITTER_ERROR_CODES.suspended,
  TWITTER_ERROR_CODES.notActive,
  TWITTER_ERROR_CODES.accountTemporarilyLocked,
])

export function isAuthError(error: unknown): boolean {
  const code = getTwitterErrorCode(error)
  return code !== null && AUTH_ERROR_CODES.has(code)
}

export function isRateLimitError(error: unknown): boolean {
  const code = getTwitterErrorCode(error)
  return code === TWITTER_ERROR_CODES.ratelimitExceeded
}

export function isStaleCursorError(error: unknown): boolean {
  const code = getTwitterErrorCode(error)
  return code === TWITTER_ERROR_CODES.pageNotFound
}

export function isCSRFMismatchError(error: unknown): boolean {
  const code = getTwitterErrorCode(error)
  return code === TWITTER_ERROR_CODES.csrfMismatch
}

export function getTwitterErrorCode(error: unknown): number | null {
  if (error instanceof TwitterApiError && typeof error.code === 'number') {
    return error.code
  }

  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'number') return code
  }

  return null
}

function formatErrorItem(item: TwitterErrorItem): string {
  return `${item.code ?? 0}: ${item.message ?? 'Unknown error'}`
}

export function parseTwitterErrorPayload(payload: string): TwitterApiError | null {
  try {
    const parsed = JSON.parse(payload) as TwitterErrorsPayload
    const errors = parsed.errors
    if (!errors || errors.length === 0) return null

    if (errors.length === 1) {
      return new TwitterApiError(formatErrorItem(errors[0]), undefined, errors[0].code)
    }

    return new TwitterApiError(errors.map(formatErrorItem).join(', '))
  } catch {
    return null
  }
}
