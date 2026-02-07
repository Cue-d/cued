/**
 * Shared utilities for syncCursors aggregation.
 * Supports multi-workspace platforms (Slack, Gmail) where a user may have
 * multiple cursors per platform.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { ActionPlatform } from "@cued/shared";

/**
 * Take the max of two nullable timestamps.
 * Returns null only when both inputs are null/undefined/0.
 */
function maxTimestamp(a: number | null, b: number | null): number | null {
  const max = Math.max(a ?? 0, b ?? 0);
  return max > 0 ? max : null;
}

/** Aggregated stats across all workspaces for a platform. */
export interface AggregatedCursorStats {
  lastSyncAt: number | null;
  totalMessagesSynced: number;
  totalContactsSynced: number;
}

/**
 * Collect all sync cursors for a user and platform.
 * Returns empty array if none found.
 */
export function collectCursors(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  platform: ActionPlatform
): Promise<Doc<"syncCursors">[]> {
  return ctx.db
    .query("syncCursors")
    .withIndex("by_user_platform", (q) =>
      q.eq("userId", userId).eq("platform", platform)
    )
    .collect();
}

/**
 * Aggregate cursor stats across multiple workspaces.
 * Uses max for timestamps and sum for counts.
 */
export function aggregateCursorStats(
  cursors: Doc<"syncCursors">[]
): AggregatedCursorStats {
  if (cursors.length === 0) {
    return {
      lastSyncAt: null,
      totalMessagesSynced: 0,
      totalContactsSynced: 0,
    };
  }

  return cursors.reduce(
    (acc, cursor) => ({
      lastSyncAt: maxTimestamp(acc.lastSyncAt, cursor.lastSyncAt ?? null),
      totalMessagesSynced:
        acc.totalMessagesSynced + (cursor.totalMessagesSynced ?? 0),
      totalContactsSynced:
        acc.totalContactsSynced + (cursor.totalContactsSynced ?? 0),
    }),
    {
      lastSyncAt: null as number | null,
      totalMessagesSynced: 0,
      totalContactsSynced: 0,
    }
  );
}

/**
 * Build a map from cursor keys to cursor documents.
 * Key format: "platform:workspaceId" for multi-workspace, or just "platform".
 */
export function buildCursorMap(
  cursors: Doc<"syncCursors">[]
): Map<string, Doc<"syncCursors">> {
  return new Map(
    cursors.map((c) => [
      c.workspaceId ? `${c.platform}:${c.workspaceId}` : c.platform,
      c,
    ])
  );
}

/**
 * Build aggregated stats per platform from a list of cursors.
 */
export function buildPlatformAggregates(
  cursors: Doc<"syncCursors">[]
): Map<string, { lastSyncAt: number; totalMessagesSynced: number }> {
  const aggregates = new Map<
    string,
    { lastSyncAt: number; totalMessagesSynced: number }
  >();

  for (const cursor of cursors) {
    const existing = aggregates.get(cursor.platform);
    if (existing) {
      aggregates.set(cursor.platform, {
        lastSyncAt: Math.max(existing.lastSyncAt, cursor.lastSyncAt ?? 0),
        totalMessagesSynced:
          existing.totalMessagesSynced + (cursor.totalMessagesSynced ?? 0),
      });
    } else {
      aggregates.set(cursor.platform, {
        lastSyncAt: cursor.lastSyncAt ?? 0,
        totalMessagesSynced: cursor.totalMessagesSynced ?? 0,
      });
    }
  }

  return aggregates;
}

