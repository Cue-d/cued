import { useQuery } from "convex/react";
import { api } from "@prm/convex/convex/_generated/api";

/**
 * Hook for fetching pending actions from Convex.
 * Returns actions sorted by priority (descending) then createdAt (descending).
 * Supports cursor-based pagination.
 */
export function useActions(options?: { limit?: number; cursor?: number }) {
  const result = useQuery(api.actions.getPendingActions, {
    limit: options?.limit,
    cursor: options?.cursor,
  });

  return {
    actions: result?.actions ?? [],
    nextCursor: result?.nextCursor ?? null,
    isLoading: result === undefined,
    error: null, // Convex useQuery throws on error, doesn't return it
  };
}
