"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@prm/convex";
import {
  ConversationList,
  MessageThread,
  type Conversation,
  type Message,
} from "@prm/ui";
import type { Id } from "@prm/convex";

export default function InboxPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Fetch inbox (list of conversations)
  const inboxResult = useQuery(api.messages.getInbox, { limit: 50 });
  const conversations = (inboxResult?.conversations ?? []) as Conversation[];
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
  const messages = (messagesResult?.messages ?? []) as Message[];
  const messagesLoading = selectedId !== null && messagesResult === undefined;

  return (
    <div className="flex h-full">
      <ConversationList
        conversations={conversations}
        selectedId={selectedId}
        onSelect={setSelectedId}
        loading={inboxLoading}
        hasMore={!!inboxResult?.nextCursor}
      />

      <div className="flex-1 min-w-0">
        {selectedConversation ? (
          <MessageThread
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
