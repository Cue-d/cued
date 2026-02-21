/**
 * Action detail screen - displays full context for an action.
 *
 * Shows complete message thread, action details, and toolbar actions.
 */

import { useState, useCallback, useMemo } from "react";
import { View, Text, ScrollView, TextInput, ActivityIndicator } from "react-native";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@cued/convex";
import { getInitials, formatTime, formatRelativeTime, type DisplayMessage } from "@cued/shared";
import { useElectronPrescence } from "@/contexts/electron-presence-context";
import { ContactAvatar } from "@/components/contact-avatar";
import type { SwipeDirection } from "@/components/swipeable-card";
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
    <View className={`w-full ${message.isFromMe ? "items-end" : "items-start"}`}>
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
          {message.isFromMe && message.status ? ` · ${message.status === "queued" ? "Queued" : message.status === "sending" ? "Sending" : message.status === "failed" ? "Failed" : message.status === "delivered" ? "Delivered" : message.status === "read" ? "Read" : "Sent"}` : ""}
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
    case "eod_contact":
      return "End of Day Contact";
    case "new_connection":
      return "New Connection";
    default:
      return type;
  }
}

/** Platform label */
function getPlatformLabel(platform: string | null): string {
  switch (platform) {
    case "imessage":
      return "iMessage";
    case "slack":
      return "Slack";
    default:
      return "Unknown";
  }
}

export default function ActionDetailScreen(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [responseText, setResponseText] = useState("");
  const { isOnline: isDesktopOnline } = useElectronPrescence();

  const data = useQuery(api.actions.getActionWithContext, {
    actionId: id as Id<"actions">,
    messageLimit: 20,
  });

  const swipeAction = useMutation(api.actions.swipeAction);

  // Paginated message loading
  const MESSAGE_PAGE_SIZE = 25;
  const [messageLimit, setMessageLimit] = useState(MESSAGE_PAGE_SIZE);

  const conversationId = data?.conversation?._id;
  const messagesResult = useQuery(
    api.messages.getMessages,
    conversationId
      ? { conversationId: conversationId as Id<"conversations">, limit: messageLimit }
      : "skip",
  );

  const hasMoreMessages = messagesResult?.nextCursor != null;
  const handleLoadMoreMessages = useCallback(() => {
    setMessageLimit((prev) => prev + MESSAGE_PAGE_SIZE);
  }, []);
  const isLoadingMoreMessages = messageLimit > MESSAGE_PAGE_SIZE && messagesResult === undefined;

  // Auto-load older messages when scrolling near the top
  const handleScroll = useCallback(
    (event: { nativeEvent: { contentOffset: { y: number } } }) => {
      const offsetY = event.nativeEvent.contentOffset.y;
      if (offsetY < 80 && hasMoreMessages && !isLoadingMoreMessages) {
        handleLoadMoreMessages();
      }
    },
    [hasMoreMessages, isLoadingMoreMessages, handleLoadMoreMessages],
  );

  // Map paginated messages to DisplayMessage format (getMessages returns newest-first)
  const messages: DisplayMessage[] = useMemo(() => {
    const paginatedMsgs = messagesResult?.messages;
    if (paginatedMsgs) {
      return [...paginatedMsgs].reverse().map((msg) => ({
        _id: msg._id,
        content: msg.content,
        sentAt: msg.sentAt,
        isFromMe: msg.isFromMe,
        senderName: msg.sender?.displayName ?? (msg.isFromMe ? "You" : null),
        status: msg.status,
        reactions: msg.reactions ?? null,
      }));
    }

    // Fall back to context messages while paginated query loads
    return data?.messages?.map((msg) => ({
      _id: msg._id,
      content: msg.content,
      sentAt: msg.sentAt,
      isFromMe: msg.isFromMe,
      senderName: msg.senderName,
      status: msg.status,
      reactions: msg.reactions ?? null,
    })) ?? [];
  }, [messagesResult?.messages, data?.messages]);

  // Handle swipe action
  const handleSwipe = useCallback(
    async (direction: SwipeDirection) => {
      if (!id) return;

      // For snooze (up), navigate to snooze picker
      if (direction === "up") {
        router.push({
          pathname: "/(actions)/snooze-picker",
          params: { actionId: id },
        });
        return;
      }

      try {
        await swipeAction({
          actionId: id as Id<"actions">,
          direction,
          responseText: direction === "right" ? responseText : undefined,
        });
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.back();
      } catch (error) {
        console.error("Failed to complete action:", error);
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    },
    [id, router, swipeAction, responseText],
  );

  // Loading state
  if (!data) {
    return (
      <>
        <Stack.Screen
          options={{
            headerLargeTitle: false,
            title: "Action",
          }}
        />
        <View className="flex-1 items-center justify-center">
          <Text className="text-sf-secondaryLabel">Loading...</Text>
        </View>
      </>
    );
  }

  // Action not found
  if (!data.action) {
    return (
      <>
        <Stack.Screen
          options={{
            headerLargeTitle: false,
            title: "Action",
          }}
        />
        <View className="flex-1 items-center justify-center">
          <Text className="text-sf-label text-lg font-semibold">
            Action not found
          </Text>
          <Text className="text-sf-secondaryLabel mt-2">
            This action may have been completed or deleted.
          </Text>
        </View>
      </>
    );
  }

  const { action, contact, conversation } = data;
  const contactName = contact?.displayName ?? "Unknown";
  const initials = getInitials(contactName);
  const contactAvatarUrl = contact?.avatarUrl ?? null;

  return (
    <>
      <Stack.Screen
        options={{
          headerLargeTitle: false,
          title: contactName,
        }}
      />
      <Stack.Toolbar placement="bottom">
        <Stack.Toolbar.Button icon="xmark" onPress={() => handleSwipe("left")} />
        <Stack.Toolbar.Spacer />
        <Stack.Toolbar.Button icon="clock" onPress={() => handleSwipe("up")} />
        <Stack.Toolbar.Spacer />
        <Stack.Toolbar.Button icon="checkmark" onPress={() => handleSwipe("right")} tintColor="#1B5E3D" />
      </Stack.Toolbar>
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

        {/* Action Details */}
        <View className="mx-4 mb-4 p-4 rounded-2xl bg-sf-secondaryBg">
          <View className="flex-row justify-between items-center mb-2">
            <Text className="text-sm font-medium text-sf-label">
              {getActionTypeLabel(action.type)}
            </Text>
            <Text className="text-xs text-sf-secondaryLabel">
              {formatRelativeTime(action.createdAt)}
            </Text>
          </View>
          {action.reason && (
            <Text className="text-sm text-sf-secondaryLabel mb-2">
              {action.reason}
            </Text>
          )}
          {action.llmReason && (
            <Text className="text-xs text-sf-tertiaryLabel italic">
              {action.llmReason}
            </Text>
          )}
          {conversation && (
            <View className="flex-row items-center justify-between mt-2 pt-2 border-t border-sf-separator">
              <Text className="text-xs text-sf-tertiaryLabel">
                {getPlatformLabel(action.platform)}
              </Text>
              {action.platform === "imessage" && (
                <View className="flex-row items-center gap-1.5">
                  <View
                    className={`w-2 h-2 rounded-full ${isDesktopOnline ? "bg-green-500" : "bg-sf-tertiaryLabel"}`}
                  />
                  <Text className="text-xs text-sf-tertiaryLabel">
                    {isDesktopOnline ? "Desktop Online" : "Desktop Offline"}
                  </Text>
                </View>
              )}
            </View>
          )}
        </View>

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

        {/* Response Input (for message actions) */}
        {(action.type === "respond" || action.type === "follow_up") && (
          <View className="mx-4 mb-4">
            <Text className="text-sm font-medium text-sf-label mb-2">
              Your Response
            </Text>
            <TextInput
              value={responseText}
              onChangeText={setResponseText}
              placeholder="Send a message..."
              placeholderTextColorClassName="accent-muted-foreground"
              multiline
              className="min-h-[100px] bg-sf-secondaryBg rounded-xl p-3 text-sf-label text-sm"
              accessibilityLabel="Response input"
            />
          </View>
        )}

        {/* Contact Handles */}
        {contact?.handles && contact.handles.length > 0 && (
          <View className="mx-4 mb-4">
            <Text className="text-sm font-medium text-sf-label mb-2">
              Contact Info
            </Text>
            <View className="bg-sf-secondaryBg rounded-xl overflow-hidden">
              {contact.handles.map((h, idx) => (
                <View
                  key={idx}
                  className={`p-3 flex-row items-center ${idx > 0 ? "border-t border-sf-separator" : ""}`}
                >
                  <Text className="text-xs text-sf-secondaryLabel w-20">
                    {h.platform}
                  </Text>
                  <Text className="text-sm text-sf-label flex-1" selectable>
                    {h.handle}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        )}
      </ScrollView>
    </>
  );
}
