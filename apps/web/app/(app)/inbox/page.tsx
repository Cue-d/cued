"use client";

import { useState, useRef, useCallback, useEffect } from "react";
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

const INBOX_PAGE_SIZE = 25;
const MESSAGE_PAGE_SIZE = 30;

function mergeUniqueById<T extends { _id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const item of items) {
    if (seen.has(item._id)) continue;
    seen.add(item._id);
    merged.push(item);
  }
  return merged;
}

export default function InboxPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [replyText, setReplyText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const electronStatus = useQuery(api.presence.getElectronStatus, {});

  // Queue message mutation for replies
  const queueMessage = useMutation(api.messageQueue.queueMessage);

  // Get selected conversation and platform filter from URL params
  const selectedId = searchParams.get("conversation");
  const platformParam = searchParams.get("platform") as PlatformFilter | null;
  const platformFilter: PlatformFilter = platformParam ?? "all";

  const [conversationLoadCursor, setConversationLoadCursor] = useState<string | null>(null);
  const [conversationNextCursor, setConversationNextCursor] = useState<string | null>(null);
  const [olderConversations, setOlderConversations] = useState<InboxConversation[]>([]);

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

  // Fetch live first page of inbox conversations
  const baseInboxResult = useQuery(api.messages.getInbox, {
    limit: INBOX_PAGE_SIZE,
    platform: platformFilter === "all" ? undefined : platformFilter,
  });

  // Fetch one older page when requested
  const loadMoreInboxResult = useQuery(
    api.messages.getInbox,
    conversationLoadCursor
      ? {
          limit: INBOX_PAGE_SIZE,
          cursor: conversationLoadCursor,
          platform: platformFilter === "all" ? undefined : platformFilter,
        }
      : "skip"
  );

  const baseConversations = (baseInboxResult?.conversations ?? []) as InboxConversation[];
  const conversations = mergeUniqueById([...baseConversations, ...olderConversations]);

  // Reset pagination when platform filter changes
  useEffect(() => {
    setConversationLoadCursor(null);
    setConversationNextCursor(null);
    setOlderConversations([]);
  }, [platformFilter]);

  // Keep next cursor from first page while no older pages are loaded.
  useEffect(() => {
    if (!baseInboxResult) return;
    if (olderConversations.length === 0) {
      setConversationNextCursor(baseInboxResult.nextCursor ?? null);
    }
  }, [baseInboxResult, olderConversations.length]);

  // Apply one loaded older page
  useEffect(() => {
    if (!conversationLoadCursor || !loadMoreInboxResult) return;
    const page = (loadMoreInboxResult.conversations ?? []) as InboxConversation[];
    setOlderConversations((prev) => mergeUniqueById([...prev, ...page]));
    setConversationNextCursor(loadMoreInboxResult.nextCursor ?? null);
    setConversationLoadCursor(null);
  }, [conversationLoadCursor, loadMoreInboxResult]);

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

  // Find the selected conversation, caching the last valid value so the thread
  // doesn't unmount during reactive query recomputation (e.g. after sending).
  const selectedConversation = conversations.find(
    (c) => c._id === effectiveSelectedId
  );
  const cachedConversationRef = useRef(selectedConversation);
  if (selectedConversation) {
    cachedConversationRef.current = selectedConversation;
  }
  const activeConversation =
    selectedConversation ?? cachedConversationRef.current;
  const requiresDesktopSender = !!activeConversation;
  const showDesktopOfflineWarning =
    requiresDesktopSender &&
    electronStatus !== undefined &&
    electronStatus.isOnline === false;

  const [messageLoadCursor, setMessageLoadCursor] = useState<string | null>(null);
  const [messageNextCursor, setMessageNextCursor] = useState<string | null>(null);
  const [olderMessages, setOlderMessages] = useState<InboxMessage[]>([]);
  const [olderMessagesConversationId, setOlderMessagesConversationId] = useState<string | null>(null);

  // Reset message pagination when conversation changes
  useEffect(() => {
    setMessageLoadCursor(null);
    setMessageNextCursor(null);
    setOlderMessages([]);
    setOlderMessagesConversationId(null);
  }, [effectiveSelectedId]);

  // Fetch live first page of messages for selected conversation
  const baseMessagesResult = useQuery(
    api.messages.getMessages,
    effectiveSelectedId
      ? {
          conversationId: effectiveSelectedId as Id<"conversations">,
          limit: MESSAGE_PAGE_SIZE,
        }
      : "skip",
  );

  // Fetch one older page of messages when requested
  const loadMoreMessagesResult = useQuery(
    api.messages.getMessages,
    effectiveSelectedId && messageLoadCursor
      ? {
          conversationId: effectiveSelectedId as Id<"conversations">,
          limit: MESSAGE_PAGE_SIZE,
          cursor: messageLoadCursor,
        }
      : "skip",
  );

  const baseMessages = (baseMessagesResult?.messages ?? []) as InboxMessage[];
  const olderMessagesForSelectedConversation =
    olderMessagesConversationId === effectiveSelectedId ? olderMessages : [];
  const messages = mergeUniqueById([
    ...baseMessages,
    ...olderMessagesForSelectedConversation,
  ]);

  // Keep next cursor from first page while no older pages are loaded.
  useEffect(() => {
    if (!baseMessagesResult || !effectiveSelectedId) return;
    if (olderMessagesConversationId !== effectiveSelectedId || olderMessages.length === 0) {
      setMessageNextCursor(baseMessagesResult.nextCursor ?? null);
    }
  }, [
    baseMessagesResult,
    effectiveSelectedId,
    olderMessagesConversationId,
    olderMessages.length,
  ]);

  // Apply one loaded older page
  useEffect(() => {
    if (!messageLoadCursor || !loadMoreMessagesResult || !effectiveSelectedId) return;
    const page = (loadMoreMessagesResult.messages ?? []) as InboxMessage[];
    setOlderMessages((prev) => mergeUniqueById([...prev, ...page]));
    setOlderMessagesConversationId(effectiveSelectedId);
    setMessageNextCursor(loadMoreMessagesResult.nextCursor ?? null);
    setMessageLoadCursor(null);
  }, [messageLoadCursor, loadMoreMessagesResult, effectiveSelectedId]);

  const inboxPageLoading =
    baseInboxResult === undefined ||
    (conversationLoadCursor !== null && loadMoreInboxResult === undefined);
  const messagePageLoading =
    (effectiveSelectedId !== null && baseMessagesResult === undefined) ||
    (messageLoadCursor !== null && loadMoreMessagesResult === undefined);

  const handleLoadMoreConversations = useCallback(() => {
    if (!conversationNextCursor) return;
    if (inboxPageLoading) return;
    if (conversationLoadCursor !== null) return;
    setConversationLoadCursor(conversationNextCursor);
  }, [conversationNextCursor, inboxPageLoading, conversationLoadCursor]);

  const handleLoadMoreMessages = useCallback(() => {
    if (!messageNextCursor) return;
    if (messagePageLoading) return;
    if (messageLoadCursor !== null) return;
    setMessageLoadCursor(messageNextCursor);
  }, [messageNextCursor, messagePageLoading, messageLoadCursor]);

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
        onLoadMore={handleLoadMoreConversations}
        loading={inboxPageLoading}
        hasMore={!!conversationNextCursor}
        platformFilter={platformFilter}
        onFilterChange={handleFilterChange}
      />

      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        {activeConversation ? (
          <>
            <div className="flex-1 min-h-0 overflow-hidden">
              <InboxMessageThread
                conversation={activeConversation}
                messages={messages}
                loading={messagePageLoading}
                hasMore={!!messageNextCursor}
                onLoadMore={handleLoadMoreMessages}
              />
            </div>
            {/* Reply input - fixed to bottom center */}
            <div className="bg-background/95 px-4 py-4 backdrop-blur-xl border-t border-border">
              <div className="mx-auto max-w-xl flex flex-col gap-2">
                {showDesktopOfflineWarning && (
                  <p className="text-xs text-muted-foreground">
                    Desktop offline. Messages stay queued until desktop reconnects.
                  </p>
                )}
                <div className="flex items-center gap-2">
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
