import { useQuery } from "convex/react";
import { api } from "@cued/convex/convex/_generated/api";
import type { Id } from "@cued/convex/convex/_generated/dataModel";

interface UseSearchOptions {
  query: string;
  limit?: number;
}

export interface SearchMessageResult {
  _id: Id<"messages">;
  conversationId: Id<"conversations">;
  content: string;
  sentAt: number;
  isFromMe: boolean;
  platform: string;
  senderName: string | null;
  conversationName: string | null;
}

export interface SearchContactResult {
  _id: Id<"contacts">;
  displayName: string;
  company: string | null;
  handles: { type: string; value: string; platform: string }[];
}

interface UseSearchResult {
  messages: SearchMessageResult[];
  contacts: SearchContactResult[];
  isLoading: boolean;
  hasQuery: boolean;
}

/**
 * Hook for searching both messages and contacts.
 * Returns results only when query is non-empty.
 */
export function useSearch({ query, limit = 20 }: UseSearchOptions): UseSearchResult {
  const trimmedQuery = query.trim();
  const shouldSearch = trimmedQuery.length >= 2;

  const messagesResult = useQuery(
    api.search.searchMessages,
    shouldSearch ? { query: trimmedQuery, limit } : "skip"
  );

  const contactsResult = useQuery(
    api.search.searchContacts,
    shouldSearch ? { query: trimmedQuery, limit } : "skip"
  );

  return {
    messages: messagesResult?.results ?? [],
    contacts: contactsResult?.results ?? [],
    isLoading: shouldSearch && (messagesResult === undefined || contactsResult === undefined),
    hasQuery: shouldSearch,
  };
}
