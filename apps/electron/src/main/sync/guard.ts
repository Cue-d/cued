/**
 * Sync Lifecycle Helpers
 *
 * Utilities for managing sync lifecycle:
 * - Progress reporting
 * - Sync intervals
 * - Concurrent sync prevention
 */

// ============================================================================
// Progress Reporting
// ============================================================================

/**
 * Create a progress reporter that tracks state and notifies listeners.
 */
export function createProgressReporter<T extends object>(
  initial: T,
  onProgress?: (progress: T) => void
): {
  update: (partial: Partial<T>) => void
  get: () => T
  setCallback: (cb: (progress: T) => void) => void
} {
  let progress = { ...initial }
  let callback = onProgress

  return {
    update(partial: Partial<T>) {
      progress = { ...progress, ...partial }
      callback?.(progress)
    },
    get() {
      return { ...progress }
    },
    setCallback(cb: (progress: T) => void) {
      callback = cb
    },
  }
}

// ============================================================================
// Sync Lifecycle Helpers
// ============================================================================

/**
 * Create an interval manager for periodic sync.
 */
export function createSyncInterval(
  runSync: () => Promise<void>,
  intervalMs: number
): {
  start: () => void
  stop: () => void
  isRunning: () => boolean
} {
  let intervalId: NodeJS.Timeout | null = null

  return {
    start() {
      if (intervalId) return
      intervalId = setInterval(() => runSync(), intervalMs)
    },
    stop() {
      if (intervalId) {
        clearInterval(intervalId)
        intervalId = null
      }
    },
    isRunning() {
      return intervalId !== null
    },
  }
}

/**
 * Guard to prevent concurrent sync runs.
 */
export function createSyncGuard(): {
  tryStart: () => boolean
  finish: () => void
  isRunning: () => boolean
} {
  let running = false

  return {
    tryStart() {
      if (running) return false
      running = true
      return true
    },
    finish() {
      running = false
    },
    isRunning() {
      return running
    },
  }
}
