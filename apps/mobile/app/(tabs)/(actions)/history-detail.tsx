/**
 * History detail screen - read-only view of a completed/discarded action.
 */

import { useState, useCallback, useMemo } from "react";
import { View, Text, ScrollView, ActivityIndicator } from "react-native";
import { useLocalSearchParams, Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useQuery } from "convex/react";
import { api } from "@cued/convex";
import {
  getInitials,
  formatTime,
  formatRelativeTime,
  type DisplayMessage,
} from "@cued/shared";
import { ContactAvatar } from "@/components/contact-avatar";
import type { Id } from "@cued/convex/convex/_generated/dataModel";


/** Avatar component */
function Avatar({
  initials,
  avatarUrl,
  size = "large",
}: {
  initials: string;
  avatarUrl?: string | null;
  size?: "small" | "large";
}): React.JSX.Element {
  const sizePx = size === "large" ? 64 : 40;
  return (
    <ContactAvatar
      initials={initials}
      avatarUrl={avatarUrl}
      size={sizePx}
      className="bg-sf-fill items-center justify-center"
      fallbackTextClassName={size === "large" ? "text-sf-label font-semibold text-xl" : "text-sf-label font-semibold text-sm"}
      transition={120}
    />
  );
}

/** Message bubble component */
function MessageBubble({
  message,
}: {
  message: DisplayMessage;
}): React.JSX.Element {
  const hasText = message.content && message.content.trim().length > 0;

  return (
    <View
      className={`w-full ${message.isFromMe ? "items-end" : "items-start"}`}
    >
      {!message.isFromMe && message.senderName && (
        <Text className="text-xs font-medium text-sf-secondaryLabel mb-1 ml-1">
          {message.senderName}
        </Text>
      )}
      <View
        className={`rounded-2xl px-4 py-2 max-w-[85%] ${message.isFromMe ? "bg-sf-blue" : "bg-sf-fill"}`}
      >
        {hasText ? (
          <Text
            className={`text-sm ${message.isFromMe ? "text-white" : "text-sf-label"}`}
            selectable
          >
            {message.content}
          </Text>
        ) : (
          <Text className="text-sm text-sf-secondaryLabel">[No text]</Text>
        )}
        <Text
          className={`text-[10px] mt-1 ${message.isFromMe ? "text-white/60 text-right" : "text-sf-tertiaryLabel"}`}
        >
          {formatTime(message.sentAt)}
        </Text>
      </View>
    </View>
  );
}

/** Action type label */
function getActionTypeLabel(type: string): string {
  switch (type) {
    case "respond":
      return "Respond";
    case "follow_up":
      return "Follow Up";
    case "send_message":
      return "Send Message";
    case "eod_contact":
      return "End of Day Contact";
    case "new_connection":
      return "New Connection";
    default:
      return type;
  }
}

export default function HistoryDetailScreen(): React.JSX.Element {
  const { actionId } = useLocalSearchParams<{ actionId: string }>();

  const data = useQuery(api.actions.getActionWithContext, {
    actionId: actionId as Id<"actions">,
    messageLimit: 20,
  });

  // Paginated message loading
  const MESSAGE_PAGE_SIZE = 25;
  const [messageLimit, setMessageLimit] = useState(MESSAGE_PAGE_SIZE);

  const conversationId = data?.conversation?._id;
  const messagesResult = useQuery(
    api.messages.getMessages,
    conversationId
      ? {
          conversationId: conversationId as Id<"conversations">,
          limit: messageLimit,
        }
      : "skip",
  );

  const hasMoreMessages = messagesResult?.nextCursor != null;
  const handleLoadMoreMessages = useCallback(() => {
    setMessageLimit((prev) => prev + MESSAGE_PAGE_SIZE);
  }, []);
  const isLoadingMoreMessages =
    messageLimit > MESSAGE_PAGE_SIZE && messagesResult === undefined;

  const handleScroll = useCallback(
    (event: { nativeEvent: { contentOffset: { y: number } } }) => {
      const offsetY = event.nativeEvent.contentOffset.y;
      if (offsetY < 80 && hasMoreMessages && !isLoadingMoreMessages) {
        handleLoadMoreMessages();
      }
    },
    [hasMoreMessages, isLoadingMoreMessages, handleLoadMoreMessages],
  );

  // Map paginated messages to DisplayMessage format
  const messages: DisplayMessage[] = useMemo(() => {
    const paginatedMsgs = messagesResult?.messages;
    if (paginatedMsgs) {
      return [...paginatedMsgs].reverse().map((msg) => ({
        _id: msg._id,
        content: msg.content,
        sentAt: msg.sentAt,
        isFromMe: msg.isFromMe,
        senderName:
          msg.sender?.displayName ?? (msg.isFromMe ? "You" : null),
        status: msg.status,
        reactions: msg.reactions ?? null,
      }));
    }

    return (
      data?.messages?.map((msg) => ({
        _id: msg._id,
        content: msg.content,
        sentAt: msg.sentAt,
        isFromMe: msg.isFromMe,
        senderName: msg.senderName,
        status: msg.status,
        reactions: msg.reactions ?? null,
      })) ?? []
    );
  }, [messagesResult?.messages, data?.messages]);

  // Loading state
  if (!data) {
    return (
      <>
        <Stack.Screen
          options={{ headerLargeTitle: false, title: "History" }}
        />
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      </>
    );
  }

  if (!data.action) {
    return (
      <>
        <Stack.Screen
          options={{ headerLargeTitle: false, title: "History" }}
        />
        <View className="flex-1 items-center justify-center">
          <Text className="text-sf-label text-lg font-semibold">
            Action not found
          </Text>
        </View>
      </>
    );
  }

  const { action, contact } = data;
  const contactName = contact?.displayName ?? "Unknown";
  const initials = getInitials(contactName);
  const contactAvatarUrl = contact?.avatarUrl ?? null;
  const isDiscarded = action.status === "discarded";
  const resolvedAt = action.completedAt ?? action.discardedAt ?? action.createdAt;

  return (
    <>
      <Stack.Screen
        options={{ headerLargeTitle: false, title: contactName }}
      />
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="pb-4"
        onScroll={handleScroll}
        scrollEventThrottle={100}
      >
        {/* Contact Header */}
        <View className="items-center pt-4 pb-6">
          <Avatar initials={initials} avatarUrl={contactAvatarUrl} size="large" />
          <Text className="text-lg font-semibold text-sf-label mt-3">
            {contactName}
          </Text>
          {contact?.company && (
            <Text className="text-sm text-sf-secondaryLabel mt-1">
              {contact.company}
            </Text>
          )}
        </View>

        {/* Status Banner */}
        <View className="mx-4 mb-4 p-4 rounded-2xl bg-sf-secondaryBg flex-row items-center gap-3">
          <SymbolView
            name={isDiscarded ? "xmark.circle" : "checkmark.circle.fill"}
            size={24}
            tintColor={isDiscarded ? "#8E8E93" : "#1B5E3D"}
          />
          <View className="flex-1">
            <Text className="text-sm font-medium text-sf-label">
              {isDiscarded ? "Skipped" : "Sent"}
            </Text>
            <Text className="text-xs text-sf-secondaryLabel mt-0.5">
              {getActionTypeLabel(action.type)} · {formatRelativeTime(resolvedAt)}
            </Text>
          </View>
        </View>

        {/* Reason */}
        {action.reason && (
          <View className="mx-4 mb-4 p-4 rounded-2xl bg-sf-secondaryBg">
            <Text className="text-sm text-sf-secondaryLabel">
              {action.reason}
            </Text>
          </View>
        )}

        {/* Message Thread */}
        {messages.length > 0 && (
          <View className="mx-4 mb-4">
            <Text className="text-sm font-medium text-sf-label mb-3">
              Messages
            </Text>
            {isLoadingMoreMessages && (
              <View className="items-center py-2 mb-2">
                <ActivityIndicator size="small" />
              </View>
            )}
            <View className="gap-2">
              {messages.map((msg) => (
                <MessageBubble key={msg._id} message={msg} />
              ))}
            </View>
          </View>
        )}

        {/* Contact Handles */}
        {contact?.handles && contact.handles.length > 0 && (
          <View className="mx-4 mb-4">
            <Text className="text-sm font-medium text-sf-label mb-2">
              Contact Info
            </Text>
            <View className="bg-sf-secondaryBg rounded-xl overflow-hidden">
              {contact.handles.map(
                (
                  h: { platform: string; handle: string },
                  idx: number,
                ) => (
                  <View
                    key={idx}
                    className={`p-3 flex-row items-center ${idx > 0 ? "border-t border-sf-separator" : ""}`}
                  >
                    <Text className="text-xs text-sf-secondaryLabel w-20">
                      {h.platform}
                    </Text>
                    <Text
                      className="text-sm text-sf-label flex-1"
                      selectable
                    >
                      {h.handle}
                    </Text>
                  </View>
                ),
              )}
            </View>
          </View>
        )}
      </ScrollView>
    </>
  );
}
