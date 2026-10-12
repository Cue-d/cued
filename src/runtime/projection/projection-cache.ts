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

export type StoredProjectionCache = {
  initialized: boolean;
  contactMergeAliasMap: Map<string, string>;
  sourceContactMap: Map<string, string>;
  deterministicHandleMap: Map<string, string>;
  conversationMap: Map<string, string>;
  contactNameMap: Map<string, string | null>;
  conversationNameMap: Map<string, string | null>;
};

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
