import type Database from "better-sqlite3-multiple-ciphers";

type Revision = { external: number; local: number };

/** Exact, connection-local read caching without triggers on the ingestion path. */
export class StatusReadCache {
  private revision: Revision | null = null;
  private values = new Map<string, unknown>();
  private version = 0;

  constructor(private readonly sqlite: Database.Database) {}

  private currentRevision(): Revision {
    return {
      external: this.sqlite.pragma("data_version", { simple: true }) as number,
      local: (this.sqlite.prepare("SELECT total_changes() AS changes").get() as { changes: number })
        .changes,
    };
  }

  private matches(left: Revision | null, right: Revision): boolean {
    return left?.external === right.external && left.local === right.local;
  }

  private observe(): Revision {
    const current = this.currentRevision();
    if (!this.matches(this.revision, current)) {
      this.values.clear();
      this.revision = current;
      this.version += 1;
    }
    return current;
  }

  /**
   * Changes whenever something that could alter status counts has been written, by this
   * connection or another. Lets a caller that computes aggregates elsewhere (the database worker)
   * skip recomputing while nothing relevant changed.
   */
  contentVersion(): number {
    this.observe();
    return this.version;
  }

  read<T>(key: string, load: () => T): T {
    // total_changes includes rolled-back writes. Never publish or reuse values
    // from inside a transaction: they may describe data that will be rolled back.
    if (this.sqlite.inTransaction) return load();
    const before = this.observe();
    if (this.values.has(key)) return structuredClone(this.values.get(key)) as T;
    // Multi-query aggregates must all see the same committed snapshot.
    const value = this.sqlite.transaction(load)();
    if (this.matches(before, this.currentRevision())) this.values.set(key, value);
    // Callers may sort or otherwise modify returned arrays without corrupting cache.
    return structuredClone(value);
  }

  /**
   * Runs a write that cannot alter status counts (daemon heartbeat, sync-run bookkeeping)
   * without invalidating cached aggregates.
   */
  preserveAcrossUncountedWrite<T>(write: () => T): T {
    if (this.sqlite.inTransaction) {
      return write();
    }
    const before = this.currentRevision();
    const result = write();
    const after = this.currentRevision();
    if (this.matches(this.revision, before) && before.external === after.external) {
      this.revision = after;
    }
    return result;
  }
}
