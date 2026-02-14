import { useEffect, useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@cued/convex";
import { updateWidgetActionsList } from "@/lib/widget-data";

/**
 * Hook for fetching pending actions from Convex.
 * Returns actions sorted by priority (descending) then createdAt (descending).
 * Supports cursor-based pagination.
 * Also syncs actions to iOS widget.
 */
export function useActions(options?: {
  enabled?: boolean;
  limit?: number;
  cursor?: number;
}) {
  const enabled = options?.enabled ?? true;
  const result = useQuery(
    api.actions.getPendingActions,
    enabled
      ? {
          limit: options?.limit,
          cursor: options?.cursor,
        }
      : "skip"
  );

  const actions = useMemo(() => result?.actions ?? [], [result?.actions]);

  // Sync actions to iOS widget when they change
  useEffect(() => {
    if (!enabled) return;
    updateWidgetActionsList(
      actions.map((action) => ({
        id: action._id,
        contactName: action.contactName ?? "Unknown",
        platform: action.platform,
        type: action.type,
      }))
    );
  }, [actions, enabled]);

  return {
    actions,
    nextCursor: result?.nextCursor ?? null,
    isLoading: enabled && result === undefined,
    error: null, // Convex useQuery throws on error, doesn't return it
  };
}
