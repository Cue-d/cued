import type { DbWorker } from "../../db/db-worker.js";
import type { Platform } from "../../platforms/core/types.js";

// A batch is one transaction, and while it runs the daemon's own writes wait for the lock. On a
// large database each deleted row costs a few cold page reads, so batches stay small.
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_BATCHES_PER_ROUND = 20;
const DEFAULT_ROUND_GAP_MS = 100;
const DEFAULT_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_START_DELAY_MS = 5_000;
const DEFER_RETRY_DELAY_MS = 1_000;

type AccountHistoryPurge = { platform: Platform; accountKey: string; queuedBefore: number };

export type SyncRunMaintenanceOptions = {
  batchSize?: number;
  batchesPerRound?: number;
  roundGapMs?: number;
  retentionIntervalMs?: number;
  startDelayMs?: number;
  now?: () => number;
  /** While this returns true the next round is postponed rather than run. */
  shouldDefer?: () => boolean;
  onError?: (error: unknown) => void;
  onPruned?: (summary: { deletedRuns: number; durationMs: number }) => void;
};

/**
 * Keeps sync-run history bounded, in the background.
 *
 * Every sync leaves a row, so without retention the table grows by thousands of rows a day
 * forever. The deletes run on the database worker, never the daemon thread, ten rows per
 * transaction with a pause between rounds: a database upgraded from before retention existed
 * can carry millions of rows, and removing an account can orphan hundreds of thousands, and
 * neither is worth making anything else wait.
 */
export class SyncRunMaintenance {
  private readonly batchSize: number;
  private readonly batchesPerRound: number;
  private readonly roundGapMs: number;
  private readonly retentionIntervalMs: number;
  private readonly startDelayMs: number;
  private readonly purges: AccountHistoryPurge[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = true;
  private nextRetentionAt = 0;
  private passDeletedRuns = 0;
  private passStartedAt = 0;

  constructor(
    private readonly worker: Pick<DbWorker, "run">,
    private readonly options: SyncRunMaintenanceOptions = {},
  ) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.batchesPerRound = options.batchesPerRound ?? DEFAULT_BATCHES_PER_ROUND;
    this.roundGapMs = options.roundGapMs ?? DEFAULT_ROUND_GAP_MS;
    this.retentionIntervalMs = options.retentionIntervalMs ?? DEFAULT_RETENTION_INTERVAL_MS;
    this.startDelayMs = options.startDelayMs ?? DEFAULT_START_DELAY_MS;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.schedule(this.startDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Queues the removed account's finished sync runs for background deletion. */
  purgeAccountHistory(platform: Platform, accountKey: string, queuedBefore: number): void {
    this.purges.push({ platform, accountKey, queuedBefore });
    if (!this.stopped && !this.running) {
      this.schedule(0);
    }
  }

  /** Resolves once the round in flight, if any, has finished. */
  async settled(): Promise<void> {
    await this.running;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.runRound().finally(() => {
        this.running = null;
      });
    }, delayMs);
    this.timer.unref?.();
  }

  /** Runs one round of batches on the worker and schedules the next. */
  private async runRound(): Promise<void> {
    if (this.options.shouldDefer?.()) {
      this.schedule(DEFER_RETRY_DELAY_MS);
      return;
    }
    let moreWork: boolean;
    try {
      moreWork = await this.runBatches();
    } catch (error) {
      if (!this.stopped) {
        this.options.onError?.(error);
        this.schedule(this.retentionIntervalMs);
      }
      return;
    }
    this.schedule(moreWork ? this.roundGapMs : Math.max(0, this.nextRetentionAt - this.now()));
  }

  private async runBatches(): Promise<boolean> {
    const round = { batchSize: this.batchSize, maxBatches: this.batchesPerRound };
    const purge = this.purges[0];
    if (purge) {
      const result = await this.worker.run("purgeAccountSyncRunHistory", { ...purge, ...round });
      if (!result.more) {
        this.purges.shift();
      }
      return true;
    }
    if (this.now() < this.nextRetentionAt) {
      return false;
    }
    if (this.passStartedAt === 0) {
      this.passStartedAt = this.now();
      this.passDeletedRuns = 0;
    }
    const result = await this.worker.run("pruneSyncRunHistory", round);
    this.passDeletedRuns += result.deleted;
    if (result.more) {
      return true;
    }
    this.nextRetentionAt = this.now() + this.retentionIntervalMs;
    if (this.passDeletedRuns > 0) {
      this.options.onPruned?.({
        deletedRuns: this.passDeletedRuns,
        durationMs: this.now() - this.passStartedAt,
      });
    }
    this.passStartedAt = 0;
    // A purge may have been queued while this round ran.
    return this.purges.length > 0;
  }
}
