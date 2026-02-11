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
export function useActions(options?: { limit?: number; cursor?: number }) {
  const result = useQuery(api.actions.getPendingActions, {
    limit: options?.limit,
    cursor: options?.cursor,
  });

  const actions = useMemo(() => result?.actions ?? [], [result?.actions]);

  // Sync actions to iOS widget when they change
  useEffect(() => {
    updateWidgetActionsList(
      actions.map((action) => ({
        id: action._id,
        contactName: action.contactName ?? "Unknown",
        platform: action.platform,
        type: action.type,
      }))
    );
  }, [actions]);

  return {
    actions,
    nextCursor: result?.nextCursor ?? null,
    isLoading: result === undefined,
    error: null, // Convex useQuery throws on error, doesn't return it
  };
}
