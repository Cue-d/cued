/** Projection only needs point lookups and writes, never iteration over the full cache. */
interface CacheLookup<T> {
  get(key: string): T | undefined;
  has(key: string): boolean;
  set(key: string, value: T): void;
}

export type ProjectionCache = {
  contactMergeAliasMap: CacheLookup<string>;
  sourceContactMap: CacheLookup<string>;
  deterministicHandleMap: CacheLookup<string>;
  conversationMap: CacheLookup<string>;
  contactNameMap: CacheLookup<string | null>;
  conversationNameMap: CacheLookup<string | null>;
};

/** The cache kept between batches; overlays on top of it hold a batch's or an event's writes. */
export type StoredProjectionCache = ProjectionCache;

/**
 * Reads an entry from the database the first time it is asked for, then keeps it.
 *
 * Loading every mapping up front cost the first projection after startup a scan of the
 * contact, source, handle and conversation tables, seconds on a real database, on the
 * daemon's thread. A batch needs a handful of keys, so it looks up only those.
 *
 * Entries read from the database are kept apart from entries the projector wrote, so that a
 * rolled-back event can drop what it read (it may have seen its own uncommitted rows) without
 * losing what earlier events committed.
 */
export class ReadThroughLookup<T> implements CacheLookup<T> {
  private readonly written = new Map<string, T>();
  /** `undefined` records a key the database does not have. */
  private readonly loaded = new Map<string, T | undefined>();

  constructor(private readonly load: (key: string) => T | undefined) {}

  get(key: string): T | undefined {
    if (this.written.has(key)) {
      return this.written.get(key);
    }
    if (this.loaded.has(key)) {
      return this.loaded.get(key);
    }
    const value = this.load(key);
    this.loaded.set(key, value);
    return value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  set(key: string, value: T): void {
    this.written.set(key, value);
  }

  forgetLoaded(): void {
    this.loaded.clear();
  }
}

class CacheOverlay<T> implements CacheLookup<T> {
  private readonly writes = new Map<string, T>();

  constructor(private readonly base: CacheLookup<T>) {}

  get(key: string): T | undefined {
    return this.writes.has(key) ? this.writes.get(key) : this.base.get(key);
  }

  has(key: string): boolean {
    return this.writes.has(key) || this.base.has(key);
  }

  set(key: string, value: T): void {
    this.writes.set(key, value);
  }

  commit(): void {
    for (const [key, value] of this.writes) {
      this.base.set(key, value);
    }
  }
}

/** Discard on rollback; publish only after the matching SQL savepoint/transaction succeeds. */
export function createProjectionCacheOverlay(base: ProjectionCache) {
  const cache = {
    contactMergeAliasMap: new CacheOverlay(base.contactMergeAliasMap),
    sourceContactMap: new CacheOverlay(base.sourceContactMap),
    deterministicHandleMap: new CacheOverlay(base.deterministicHandleMap),
    conversationMap: new CacheOverlay(base.conversationMap),
    contactNameMap: new CacheOverlay(base.contactNameMap),
    conversationNameMap: new CacheOverlay(base.conversationNameMap),
  };
  return {
    cache,
    commit() {
      for (const map of Object.values(cache)) {
        map.commit();
      }
    },
  };
}
