"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { Send, Loader2 } from "lucide-react";
import { api } from "@cued/convex";
import {
  InboxConversationList,
  InboxMessageThread,
  type InboxConversation,
  type InboxMessage,
  type InboxPlatform,
} from "@cued/ui";
import type { Id } from "@cued/convex";

type PlatformFilter = InboxPlatform | "all";

export default function InboxPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [replyText, setReplyText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Queue message mutation for replies
  const queueMessage = useMutation(api.messageQueue.queueMessage);

  // Get selected conversation and platform filter from URL params
  const selectedId = searchParams.get("conversation");
  const platformParam = searchParams.get("platform") as PlatformFilter | null;
  const platformFilter: PlatformFilter = platformParam ?? "all";

  // Update URL when conversation is selected
  const handleSelectConversation = useCallback(
    (id: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (id) {
        params.set("conversation", id);
      } else {
        params.delete("conversation");
      }
      router.push(`/inbox${params.toString() ? `?${params.toString()}` : ""}`);
    },
    [router, searchParams]
  );

  // Update URL when filter changes
  const handleFilterChange = (platform: PlatformFilter) => {
    const params = new URLSearchParams(searchParams.toString());
    if (platform === "all") {
      params.delete("platform");
    } else {
      params.set("platform", platform);
    }
    // Clear conversation selection when changing filter
    params.delete("conversation");
    router.push(`/inbox${params.toString() ? `?${params.toString()}` : ""}`);
  };

  // Fetch inbox (list of conversations) with platform filter
  const inboxResult = useQuery(api.messages.getInbox, {
    limit: 50,
    platform: platformFilter === "all" ? undefined : platformFilter,
  });
  const conversations = useMemo(
    () => (inboxResult?.conversations ?? []) as InboxConversation[],
    [inboxResult?.conversations]
  );
  const inboxLoading = inboxResult === undefined;

  // Default to first conversation if none selected
  const effectiveSelectedId = selectedId ?? conversations[0]?._id ?? null;

  // Sync URL when defaulting to first conversation
  useEffect(() => {
    if (!selectedId && conversations.length > 0) {
      const params = new URLSearchParams(searchParams.toString());
      params.set("conversation", conversations[0]._id);
      router.replace(`/inbox?${params.toString()}`);
    }
  }, [selectedId, conversations, searchParams, router]);

  // Find the selected conversation
  const selectedConversation = conversations.find(
    (c) => c._id === effectiveSelectedId
  );

  // Fetch messages for selected conversation
  const messagesResult = useQuery(
    api.messages.getMessages,
    effectiveSelectedId
      ? { conversationId: effectiveSelectedId as Id<"conversations">, limit: 100 }
      : "skip",
  );
  const messages = (messagesResult?.messages ?? []) as InboxMessage[];
  const messagesLoading =
    effectiveSelectedId !== null && messagesResult === undefined;

  // Handle sending a reply message inline
  const handleSendReply = useCallback(async () => {
    if (!selectedConversation || !replyText.trim() || isSending) return;

    setIsSending(true);
    try {
      const isGroup =
        selectedConversation.conversationType === "group" ||
        selectedConversation.conversationType === "channel";

      // For DMs: use the participant's handle (phone number/email)
      // For groups: recipientHandle is empty, use chatIdentifier instead
      const participant = selectedConversation.participants[0];
      const recipientHandle = isGroup ? "" : (participant?.handle ?? "");
      const recipientContactId = participant?._id;

      // Slack and LinkedIn always need chatIdentifier (channel/conversation ID)
      // Other platforms only need it for group chats
      const isSlack = selectedConversation.platform === "slack";
      const isLinkedIn = selectedConversation.platform === "linkedin";
      const needsChatIdentifier = isSlack || isLinkedIn || isGroup;

      // Slack uses chatIdentifier; other platforms need recipientHandle for DMs
      if (!needsChatIdentifier && !recipientHandle) {
        return;
      }

      await queueMessage({
        platform: selectedConversation.platform,
        recipientHandle,
        recipientContactId: recipientContactId
          ? (recipientContactId as Id<"contacts">)
          : undefined,
        text: replyText.trim(),
        isGroup,
        chatIdentifier: needsChatIdentifier
          ? selectedConversation.platformConversationId
          : undefined,
        conversationId: selectedConversation._id as Id<"conversations">,
        workspaceId: selectedConversation.workspaceId ?? undefined,
      });

        // Clear input on success
        setReplyText("");
        inputRef.current?.focus();
      } catch (error) {
        console.error("Failed to send reply:", error);
      } finally {
        setIsSending(false);
      }
    },
    [selectedConversation, replyText, isSending, queueMessage]
  );

  // Handle keyboard shortcuts
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendReply();
    }
  };

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <InboxConversationList
        conversations={conversations}
        selectedId={effectiveSelectedId}
        onSelect={handleSelectConversation}
        loading={inboxLoading}
        hasMore={!!inboxResult?.nextCursor}
        platformFilter={platformFilter}
        onFilterChange={handleFilterChange}
      />

      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        {selectedConversation ? (
          <>
            <div className="flex-1 min-h-0 overflow-hidden">
              <InboxMessageThread
                conversation={selectedConversation}
                messages={messages}
                loading={messagesLoading}
                hasMore={!!messagesResult?.nextCursor}
              />
            </div>
            {/* Reply input - fixed to bottom center */}
            <div className="bg-background/95 px-4 py-4 backdrop-blur-xl border-t border-border">
              <div className="mx-auto max-w-xl flex items-center gap-2">
                <input
                  ref={inputRef}
                  type="text"
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type a reply..."
                  disabled={isSending}
                  className="flex-1 h-10 px-4 text-sm bg-muted/50 border border-border rounded-full placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:bg-background transition-colors"
                />
                <button
                  type="button"
                  onClick={handleSendReply}
                  disabled={!replyText.trim() || isSending}
                  className="flex items-center justify-center w-10 h-10 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isSending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>
          </>
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
