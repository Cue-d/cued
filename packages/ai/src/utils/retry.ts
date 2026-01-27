/**
 * Shared retry utilities for LLM calls.
 */

/** Delay execution for exponential backoff */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an async function with retry on failure.
 * Uses exponential backoff: 1s, 2s, 3s, etc.
 *
 * @param fn - Async function to execute
 * @param options - Retry options
 * @returns Result of fn, or defaultValue if all retries fail
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    defaultValue: T;
    logPrefix?: string;
  }
): Promise<T> {
  const { maxRetries = 2, defaultValue, logPrefix = "withRetry" } = options;
  const totalAttempts = maxRetries + 1;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < totalAttempts) {
        await delay(1000 * attempt);
      }
    }
  }

  console.error(`${logPrefix} failed after retries:`, lastError?.message);
  return defaultValue;
}
