import { useQuery } from "convex/react";
import { api } from "@cued/convex";
import type { Id } from "@cued/convex/convex/_generated/dataModel";

/**
 * Hook for fetching contacts from Convex.
 * Supports search filtering and cursor-based pagination.
 */
export function useContacts(options?: {
  limit?: number;
  cursor?: { displayName: string; _id: Id<"contacts"> };
  searchQuery?: string;
}) {
  const result = useQuery(api.contacts.getContacts, {
    limit: options?.limit,
    cursor: options?.cursor,
    searchQuery: options?.searchQuery,
  });

  return {
    contacts: result?.contacts ?? [],
    nextCursor: result?.nextCursor ?? null,
    isLoading: result === undefined,
    error: null, // Convex useQuery throws on error, doesn't return it
  };
}
