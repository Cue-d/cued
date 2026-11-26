import type { CuedDatabase } from "../../db/database.js";
import type { DbWorker } from "../../db/db-worker.js";
import type { LocalAccess, StatusAggregates } from "../../db/db-worker-jobs.js";
import { GlobalCuedSkillMonitor } from "../../skills/install.js";

const DEFAULT_LOCAL_ACCESS_MAX_AGE_MS = 3_000;

export type ReadModelTopic = "aggregates" | "local-access" | "skill";

type ReadModelDatabase = Pick<CuedDatabase, "statusContentVersion">;

/**
 * The slow-to-learn parts of what the UI shows, kept warm so requests never wait on them.
 *
 * Counting rows in a multi-gigabyte database, spawning the native helper to check Contacts and
 * Messages access, and asking `npx` about the installed skill each take tens of milliseconds
 * to seconds. Requests read the latest value from here instantly; refreshes run on the
 * database worker (or a child process) and report through `onChange` when a value actually moved, so
 * the daemon can notify subscribers instead of making them poll.
 */
export class DaemonReadModel {
  readonly skill: GlobalCuedSkillMonitor;
  private latestAggregates: StatusAggregates | null = null;
  private aggregatesVersion: number | null = null;
  private aggregatesRefresh: Promise<void> | null = null;
  private latestLocalAccess: LocalAccess | null = null;
  private localAccessProbedAt = Number.NEGATIVE_INFINITY;
  private localAccessRefresh: Promise<LocalAccess> | null = null;
  private closed = false;

  constructor(
    private readonly db: ReadModelDatabase,
    private readonly executor: DbWorker,
    private readonly options: {
      onChange?: (topic: ReadModelTopic) => void;
      onError?: (topic: ReadModelTopic, error: unknown) => void;
      localAccessMaxAgeMs?: number;
      now?: () => number;
      skill?: GlobalCuedSkillMonitor;
    } = {},
  ) {
    this.skill =
      options.skill ?? new GlobalCuedSkillMonitor({ onChange: () => this.emit("skill") });
  }

  private emit(topic: ReadModelTopic): void {
    this.options.onChange?.(topic);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Row counts as of the last refresh, or null before the first one lands. */
  get aggregates(): StatusAggregates | null {
    return this.latestAggregates;
  }

  /**
   * Recounts on the database worker if anything countable was written since the last count.
   * Safe to call as often as you like: it is a no-op while nothing changed, and overlapping
   * calls collapse into the refresh already running plus at most one more.
   */
  refreshAggregates(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    if (this.aggregatesRefresh) {
      return this.aggregatesRefresh;
    }
    const version = this.db.statusContentVersion();
    if (this.latestAggregates && version === this.aggregatesVersion) {
      return Promise.resolve();
    }
    this.aggregatesRefresh = this.executor.run("statusAggregates").then(
      (aggregates) => {
        const changed = JSON.stringify(aggregates) !== JSON.stringify(this.latestAggregates);
        this.latestAggregates = aggregates;
        this.aggregatesVersion = version;
        this.aggregatesRefresh = null;
        if (changed) {
          this.emit("aggregates");
        }
        if (!this.closed && this.db.statusContentVersion() !== version) {
          // Something was written while the count ran; count again so we converge.
          void this.refreshAggregates();
        }
      },
      (error) => {
        // No automatic retry: a failing worker would turn that into a tight loop. The next
        // caller (status is rewritten on a timer and on every change) tries again.
        this.aggregatesRefresh = null;
        if (!this.closed) {
          this.options.onError?.("aggregates", error);
        }
      },
    );
    return this.aggregatesRefresh;
  }

  /** Stops refreshing. Call before closing the worker so shutdown does not log failures. */
  close(): void {
    this.closed = true;
  }

  /** Contacts/Messages access as of the last probe, or null before the first one lands. */
  get localAccess(): LocalAccess | null {
    return this.latestLocalAccess;
  }

  /**
   * Re-probes Contacts/Messages access off-thread unless the last probe is fresh enough.
   * Resolves with the newest value; callers that must answer immediately read `localAccess`
   * and let `onChange` announce the refresh.
   */
  refreshLocalAccess(options: { maxAgeMs?: number } = {}): Promise<LocalAccess> {
    if (this.localAccessRefresh) {
      return this.localAccessRefresh;
    }
    const maxAgeMs =
      options.maxAgeMs ?? this.options.localAccessMaxAgeMs ?? DEFAULT_LOCAL_ACCESS_MAX_AGE_MS;
    if (this.latestLocalAccess && this.now() - this.localAccessProbedAt < maxAgeMs) {
      return Promise.resolve(this.latestLocalAccess);
    }
    this.localAccessRefresh = this.executor
      .run("localAccess")
      .then((localAccess) => {
        const changed = JSON.stringify(localAccess) !== JSON.stringify(this.latestLocalAccess);
        this.latestLocalAccess = localAccess;
        this.localAccessProbedAt = this.now();
        if (changed) {
          this.emit("local-access");
        }
        return localAccess;
      })
      .finally(() => {
        this.localAccessRefresh = null;
      });
    this.localAccessRefresh.catch((error) => {
      if (!this.closed) {
        this.options.onError?.("local-access", error);
      }
    });
    return this.localAccessRefresh;
  }
}
