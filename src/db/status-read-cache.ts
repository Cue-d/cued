import type Database from "better-sqlite3-multiple-ciphers";

type Revision = { external: number; local: number };

/** Exact, connection-local read caching without triggers on the ingestion path. */
export class StatusReadCache {
  private revision: Revision | null = null;
  private values = new Map<string, unknown>();

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

  read<T>(key: string, load: () => T): T {
    // total_changes includes rolled-back writes. Never publish or reuse values
    // from inside a transaction: they may describe data that will be rolled back.
    if (this.sqlite.inTransaction) return load();
    const before = this.currentRevision();
    if (!this.matches(this.revision, before)) {
      this.values.clear();
      this.revision = before;
    }
    if (this.values.has(key)) return structuredClone(this.values.get(key)) as T;
    // Multi-query aggregates must all see the same committed snapshot.
    const value = this.sqlite.transaction(load)();
    if (this.matches(before, this.currentRevision())) this.values.set(key, value);
    // Callers may sort or otherwise modify returned arrays without corrupting cache.
    return structuredClone(value);
  }

  /** Only daemon_state writes are allowed here; they cannot alter status counts. */
  preserveAcrossDaemonHeartbeat(write: () => void): void {
    if (this.sqlite.inTransaction) {
      write();
      return;
    }
    const before = this.currentRevision();
    write();
    const after = this.currentRevision();
    if (this.matches(this.revision, before) && before.external === after.external) {
      this.revision = after;
    }
  }
}
