/**
 * Shared error helpers for sync and adapter flows.
 */

const DEFAULT_PERMANENT_ERROR_PATTERNS = [
  "not found",
  "invalid",
  "forbidden",
  "unauthorized",
  "unauthenticated",
  "401",
  "403",
] as const;

const DEFAULT_TRANSIENT_ERROR_PATTERNS = [
  "timeout",
  "connection",
  "network",
  "rate limit",
  "429",
  "500",
  "502",
  "503",
  "504",
] as const;

interface RetryableErrorOptions {
  permanentPatterns?: readonly string[];
  transientPatterns?: readonly string[];
  defaultRetryable?: boolean;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classify whether an error is retryable based on string patterns.
 */
export function isRetryableError(
  error: unknown,
  options: RetryableErrorOptions = {}
): boolean {
  const {
    permanentPatterns = DEFAULT_PERMANENT_ERROR_PATTERNS,
    transientPatterns = DEFAULT_TRANSIENT_ERROR_PATTERNS,
    defaultRetryable = true,
  } = options;

  const lowerError = getErrorMessage(error).toLowerCase();

  if (permanentPatterns.some((pattern) => lowerError.includes(pattern))) {
    return false;
  }

  if (transientPatterns.some((pattern) => lowerError.includes(pattern))) {
    return true;
  }

  return defaultRetryable;
}
