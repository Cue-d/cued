/**
 * Action detail screen - displays full context for an action.
 *
 * Task 7.5: Add action detail route for full context.
 * Shows complete message thread, action details, and ActionButtons.
 */

import { useState, useCallback } from "react";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import * as Haptics from "expo-haptics";
import { View, Text, ScrollView, TextInput } from "react-native";
import { ActionButtons } from "@/components/action-buttons";
import type { SwipeDirection } from "@/components/swipeable-card";
import type { DisplayMessage } from "@/components/cards";
import { api } from "@prm/convex/convex/_generated/api";
import type { Id } from "@prm/convex/convex/_generated/dataModel";
import { useElectronPresence } from "@/hooks/useElectronPresence";

/** Format timestamp to relative time */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  return "Just now";
}

/** Format timestamp to time string */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Get initials from a name */
function getInitials(name: string): string {
  if (/^\+?\d/.test(name)) return "#";
  if (name.includes("@")) return name[0]?.toUpperCase() ?? "?";
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/** Avatar component */
function Avatar({
  initials,
  size = "large",
}: {
  initials: string;
  size?: "small" | "large";
}): React.JSX.Element {
  const sizeClasses = size === "large" ? "w-16 h-16 text-xl" : "w-10 h-10 text-sm";
  return (
    <View
      className={`rounded-full bg-sf-fill items-center justify-center ${sizeClasses}`}
    >
      <Text className="text-sf-label font-semibold">{initials}</Text>
    </View>
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
    case "gmail":
      return "Gmail";
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
  const { isOnline: isDesktopOnline } = useElectronPresence();

  const data = useQuery(api.actions.getActionWithContext, {
    actionId: id as Id<"actions">,
    messageLimit: 20,
  });

  const swipeAction = useMutation(api.actions.swipeAction);

  // Transform Convex messages to DisplayMessage format
  const messages: DisplayMessage[] =
    data?.messages?.map((msg) => ({
      _id: msg._id,
      content: msg.content,
      sentAt: msg.sentAt,
      isFromMe: msg.isFromMe,
      senderName: msg.senderName,
      status: msg.status,
      // Extract just the emoji strings from reaction objects
      reactions: msg.reactions?.map((r) => r.emoji) ?? null,
      attachments: msg.attachments?.map((att) => ({
        filename: att.filename,
        mimeType: att.mimeType,
        url: att.url,
        thumbnailUrl: att.thumbnailUrl,
      })),
    })) ?? [];

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

  // Initialize response text from draft
  const draftText =
    data?.action?.draftResponse ?? data?.action?.draftMessage ?? "";
  if (responseText === "" && draftText) {
    setResponseText(draftText);
  }

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

  return (
    <>
      <Stack.Screen
        options={{
          headerLargeTitle: false,
          title: contactName,
        }}
      />
      <View className="flex-1">
        <ScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="pb-4"
        >
          {/* Contact Header */}
          <View className="items-center pt-4 pb-6">
            <Avatar initials={initials} size="large" />
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
                Recent Messages
              </Text>
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
                placeholder="Type your response..."
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

        {/* Action Buttons */}
        <View className="px-4 pb-8 bg-sf-bg">
          <ActionButtons onSwipe={handleSwipe} />
        </View>
      </View>
    </>
  );
}
