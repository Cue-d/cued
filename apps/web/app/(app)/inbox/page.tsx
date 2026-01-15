"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { useSearchParams, useRouter } from "next/navigation";
import { api } from "@prm/convex";
import {
  InboxConversationList,
  InboxMessageThread,
  type InboxConversation,
  type InboxMessage,
  type InboxPlatform,
} from "@prm/ui";
import type { Id } from "@prm/convex";

type PlatformFilter = InboxPlatform | "all";

export default function InboxPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Get platform filter from URL params
  const platformParam = searchParams.get("platform") as PlatformFilter | null;
  const platformFilter: PlatformFilter = platformParam ?? "all";

  // Update URL when filter changes
  const handleFilterChange = (platform: PlatformFilter) => {
    const params = new URLSearchParams(searchParams.toString());
    if (platform === "all") {
      params.delete("platform");
    } else {
      params.set("platform", platform);
    }
    router.push(`/inbox${params.toString() ? `?${params.toString()}` : ""}`);
    // Clear selection when changing filter
    setSelectedId(null);
  };

  // Fetch inbox (list of conversations) with platform filter
  const inboxResult = useQuery(api.messages.getInbox, {
    limit: 50,
    platform: platformFilter === "all" ? undefined : platformFilter,
  });
  const conversations = (inboxResult?.conversations ?? []) as InboxConversation[];
  const inboxLoading = inboxResult === undefined;

  // Find the selected conversation
  const selectedConversation = conversations.find((c) => c._id === selectedId);

  // Fetch messages for selected conversation
  const messagesResult = useQuery(
    api.messages.getMessages,
    selectedId
      ? { conversationId: selectedId as Id<"conversations">, limit: 100 }
      : "skip",
  );
  const messages = (messagesResult?.messages ?? []) as InboxMessage[];
  const messagesLoading = selectedId !== null && messagesResult === undefined;

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <InboxConversationList
        conversations={conversations}
        selectedId={selectedId}
        onSelect={setSelectedId}
        loading={inboxLoading}
        hasMore={!!inboxResult?.nextCursor}
        platformFilter={platformFilter}
        onFilterChange={handleFilterChange}
      />

      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        {selectedConversation ? (
          <InboxMessageThread
            conversation={selectedConversation}
            messages={messages}
            loading={messagesLoading}
            hasMore={!!messagesResult?.nextCursor}
          />
        ) : (
          <div className="flex items-center justify-center h-full bg-muted/30">
            <p className="text-muted-foreground">
              Select a conversation to view messages
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
