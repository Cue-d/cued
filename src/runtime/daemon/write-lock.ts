import type { CuedDatabase } from "../../db/database.js";

export const SQLITE_BUSY_SKIPPED = Symbol("sqlite-busy-skipped");

function isSqliteBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /sqlite_(busy|locked)|database is locked|database is busy/i.test(message);
}

/**
 * Runs database work for a job on the daemon thread without waiting for the write lock.
 *
 * Every request waits behind whatever the daemon thread is doing, so a timer job must not sit
 * in SQLite's busy handler while a worker holds the lock. With a busy timeout of zero, SQLite
 * reports the lock as taken at once; this returns SQLITE_BUSY_SKIPPED and the caller tries
 * again shortly. Any other error is rethrown.
 */
export function withoutWaitingForWriteLock<T>(
  db: Pick<CuedDatabase, "withBusyTimeoutSync">,
  task: () => T,
): T | typeof SQLITE_BUSY_SKIPPED {
  try {
    return db.withBusyTimeoutSync(0, task);
  } catch (error) {
    if (isSqliteBusyError(error)) {
      return SQLITE_BUSY_SKIPPED;
    }
    throw error;
  }
}

/**
 * A job that runs every `intervalMs` on the daemon thread and needs the write lock. `run`
 * returns SQLITE_BUSY_SKIPPED when it found the lock taken (see withoutWaitingForWriteLock);
 * the job then tries again after `busyRetryMs` rather than waiting out a whole interval, so
 * its work still lands soon after the lock frees up.
 */
export class BusyRetryingTimerJob {
  private timer: NodeJS.Timeout | null = null;
  private busyStreak = 0;
  private stopped = false;

  constructor(
    private readonly options: {
      intervalMs: number;
      busyRetryMs: number;
      run: () => unknown;
      /** Called on the first busy skip of a streak. */
      onBusy?: () => void;
      /** Called when the job lands after `retries` busy skips. */
      onRecovered?: (retries: number) => void;
    },
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule(this.options.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.tick(), delayMs);
  }

  private tick(): void {
    this.timer = null;
    let outcome: unknown;
    try {
      outcome = this.options.run();
    } catch (error) {
      // One failed run must not end the job: keep the schedule, then let the error surface.
      this.schedule(this.options.intervalMs);
      throw error;
    }
    if (outcome === SQLITE_BUSY_SKIPPED) {
      if (this.busyStreak === 0) {
        this.options.onBusy?.();
      }
      this.busyStreak += 1;
      this.schedule(this.options.busyRetryMs);
      return;
    }
    if (this.busyStreak > 0) {
      this.options.onRecovered?.(this.busyStreak);
      this.busyStreak = 0;
    }
    this.schedule(this.options.intervalMs);
  }
}
