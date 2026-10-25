/** Quiet polling remains bounded; realtime catch-up can wait longer than pull-only ingestion. */
export class AutoSyncPacing {
  private quietRuns = new Map<string, number>();

  record(key: string, insertedEvents: number, hasMore: boolean): void {
    if (insertedEvents > 0 || hasMore) {
      this.reset(key);
    } else {
      this.quietRuns.set(key, Math.min(3, (this.quietRuns.get(key) ?? 0) + 1));
    }
  }

  reset(key: string): void {
    this.quietRuns.delete(key);
  }

  interval(key: string, baseMs: number, realtimeConnected: boolean): number {
    return baseMs * Math.min(realtimeConnected ? 8 : 2, 2 ** (this.quietRuns.get(key) ?? 0));
  }
}
