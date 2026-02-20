/**
 * MessageResponseCard component for mobile action queue.
 *
 * Task 6.1: Create header with Avatar, person name, relative timestamp, platform badge
 * Task 6.2: Message bubbles (will implement later)
 * Task 6.3: Response input (will implement later)
 */

import { useMemo, useRef, useCallback } from "react";
import { View, Text, ScrollView, Pressable, Linking, useColorScheme, ActivityIndicator } from "react-native";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import {
  formatTime,
  type ActionPlatform,
  type MessageAttachment,
  type DisplayMessage,
} from "@cued/shared";
import { ChatInput } from "@/components/chat/chat-input";
import { PlatformIcon } from "@/components/platform-icons";
import { cn, getThemeColors } from "@/lib/utils";
import type { ScrollView as ScrollViewType } from "react-native";

/** Re-export types for backwards compatibility */
export type { ActionPlatform, MessageAttachment, DisplayMessage } from "@cued/shared";

export interface MessageResponseCardProps {
  /** Person name for header */
  personName: string;
  /** Timestamp for relative time display */
  messageTimestamp?: number;
  /** Array of messages to display */
  messages: DisplayMessage[];
  /** Current response text */
  responseText: string;
  /** Called when response text changes */
  onResponseChange: (text: string) => void;
  /** Optional class name */
  className?: string;
  /** Current platform for sending */
  platform?: ActionPlatform;
  /** Whether the desktop app is online (for iMessage remote send) */
  isDesktopOnline?: boolean;
  /** Called when the platform icon is pressed to open in app */
  onOpenInApp?: (() => void) | null;
  /** Called when the send button is pressed */
  onSend?: () => void;
  /** Whether there are older messages to load */
  hasMore?: boolean;
  /** Called when user wants to load older messages */
  onLoadMore?: () => void;
  /** Whether older messages are currently loading */
  isLoadingMore?: boolean;
  /** Whether this action has been completed (message sent) */
  isCompleted?: boolean;
}

/**
 * Parse Slack-style markup in message content into React Native Text elements.
 * Handles:
 *  - `<URL|label>` → pressable link with label text
 *  - `<URL>` → pressable link showing truncated URL
 *  - `<@USER_ID>` / `<@USER_ID|name>` → @mention
 *  - `<#CHANNEL_ID|name>` → #channel
 */
function parseSlackContent(text: string, textClassName: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /<([^>]+)>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    const inner = match[1];

    if (inner.startsWith("@")) {
      const pipeIdx = inner.indexOf("|");
      const label = pipeIdx !== -1 ? inner.slice(pipeIdx + 1) : inner;
      parts.push(
        <Text key={match.index} className={`${textClassName} font-medium`}>
          {pipeIdx !== -1 ? `@${label}` : label}
        </Text>,
      );
    } else if (inner.startsWith("#")) {
      const pipeIdx = inner.indexOf("|");
      const label = pipeIdx !== -1 ? inner.slice(pipeIdx + 1) : inner;
      parts.push(
        <Text key={match.index} className={`${textClassName} font-medium`}>
          {pipeIdx !== -1 ? `#${label}` : label}
        </Text>,
      );
    } else if (inner.startsWith("http://") || inner.startsWith("https://") || inner.startsWith("mailto:")) {
      const pipeIdx = inner.indexOf("|");
      const url = pipeIdx !== -1 ? inner.slice(0, pipeIdx) : inner;
      const label = pipeIdx !== -1 ? inner.slice(pipeIdx + 1) : undefined;

      let displayText: string;
      if (label) {
        displayText = label;
      } else {
        try {
          const parsed = new URL(url);
          const path = parsed.pathname === "/" ? "" : parsed.pathname;
          displayText = parsed.hostname + path;
          if (displayText.length > 50) {
            displayText = displayText.slice(0, 47) + "...";
          }
        } catch {
          displayText = url.length > 50 ? url.slice(0, 47) + "..." : url;
        }
      }

      parts.push(
        <Text
          key={match.index}
          className="text-blue-500"
          onPress={() => Linking.openURL(url)}
        >
          {displayText}
        </Text>,
      );
    } else {
      parts.push(`<${inner}>`);
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

/** Status display config */
const STATUS_CONFIG: Record<string, { text: string; className: string }> = {
  queued: { text: "Queued", className: "text-muted-foreground" },
  failed: { text: "!", className: "text-red-500" },
  read: { text: "Read", className: "text-blue-400" },
  delivered: { text: "Delivered", className: "text-muted-foreground" },
};

/** Delivery status indicator */
function DeliveryStatus({ status }: { status?: string | null }): React.JSX.Element {
  const config = status ? STATUS_CONFIG[status] : undefined;
  const { text, className } = config ?? { text: "Sent", className: "text-muted-foreground" };

  return (
    <Text className={`${className} text-[10px]`} accessibilityLabel={text}>
      {text}
    </Text>
  );
}

/** Attachment display component */
function AttachmentDisplay({
  attachments,
  mutedColor,
}: {
  attachments: MessageAttachment[];
  mutedColor: string;
}): React.JSX.Element {
  return (
    <View className="mb-1 gap-1">
      {attachments.map((att, idx) => {
        const isImage = att.mimeType?.startsWith("image/");
        const url = att.thumbnailUrl || att.url;

        if (isImage && url) {
          return (
            <Image
              key={idx}
              source={{ uri: url }}
              className="w-[200px] h-[200px] rounded-lg object-cover"
              accessibilityLabel={att.filename || "Image attachment"}
            />
          );
        }

        return (
          <View
            key={idx}
            className="flex-row items-center gap-2"
          >
            <SymbolView name="doc.fill" size={12} tintColor={mutedColor} />
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              {att.filename || "Attachment"}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** Reaction badges component */
function ReactionBadges({
  reactions,
  isSent,
}: {
  reactions: string[];
  isSent: boolean;
}): React.JSX.Element {
  const displayReactions = reactions.slice(0, 3);
  return (
    <View
      className={cn(
        "absolute -top-3 flex-row gap-0.5 px-2 py-1 rounded-full bg-card border border-border z-10",
        isSent ? "-left-3" : "-right-3",
      )}
    >
      {displayReactions.map((emoji, idx) => (
        <Text key={idx} className="text-sm">
          {emoji}
        </Text>
      ))}
    </View>
  );
}

/**
 * MessageResponseCard component for action queue.
 * Displays message history and response textarea.
 */
export function MessageResponseCard({
  personName,
  messageTimestamp,
  messages,
  responseText,
  onResponseChange,
  className,
  platform,
  isDesktopOnline,
  onOpenInApp,
  onSend,
  hasMore,
  onLoadMore,
  isLoadingMore,
  isCompleted = false,
}: MessageResponseCardProps): React.JSX.Element {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = getThemeColors(isDark);
  const scrollViewRef = useRef<ScrollViewType>(null);

  // Sort messages chronologically (oldest first)
  const sortedMessages = useMemo(
    () => [...messages].sort((a, b) => a.sentAt - b.sentAt),
    [messages],
  );
  const requiresDesktopSender = Boolean(platform);
  const showDesktopOfflineWarning =
    requiresDesktopSender && isDesktopOnline === false;

  // Only scroll to bottom on initial load (not when older messages are prepended)
  const hasScrolledRef = useRef(false);
  const prevMessageCountRef = useRef(0);

  const handleContentSizeChange = useCallback(() => {
    const prevCount = prevMessageCountRef.current;
    const newCount = messages.length;
    prevMessageCountRef.current = newCount;

    // Initial load or first messages arriving — scroll to bottom
    if (!hasScrolledRef.current && newCount > 0) {
      hasScrolledRef.current = true;
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: false });
      }, 50);
      return;
    }

    // If messages were added but we already had some, it's older messages being prepended
    // maintainVisibleContentPosition handles preserving scroll position
  }, [messages.length]);

  // Auto-load older messages when scrolling near the top
  const handleScroll = useCallback(
    (event: { nativeEvent: { contentOffset: { y: number } } }) => {
      const offsetY = event.nativeEvent.contentOffset.y;
      if (offsetY < 80 && hasMore && !isLoadingMore && onLoadMore) {
        onLoadMore();
      }
    },
    [hasMore, isLoadingMore, onLoadMore],
  );

  return (
    <View className={cn("flex-1 overflow-hidden", className)}>
      {/* Header - centered name, platform top-right */}
      <View className="px-4 pt-4 pb-2">
        <View className="flex-row items-center justify-center relative">
          <Text
            className="font-semibold text-base text-foreground text-center"
            numberOfLines={1}
          >
            {personName}
          </Text>
          {platform && (
            <Pressable
              className={cn(
                "absolute right-0 flex-row items-center gap-1.5 rounded-lg px-2.5 py-1.5",
                onOpenInApp ? "bg-muted active:opacity-70" : "bg-muted/40 opacity-50",
              )}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onOpenInApp?.();
              }}
              disabled={!onOpenInApp}
              accessibilityLabel={onOpenInApp ? `Open in ${platform}` : platform}
              accessibilityRole={onOpenInApp ? "button" : undefined}
            >
              <PlatformIcon platform={platform} size={12} />
              <Text className="text-xs font-medium text-foreground">Open</Text>
            </Pressable>
          )}
        </View>
      </View>

      {/* Message Context */}
      <ScrollView
        ref={scrollViewRef}
        className="flex-1"
        contentContainerClassName="py-4 px-4 gap-2"
        onContentSizeChange={handleContentSizeChange}
        onScroll={handleScroll}
        scrollEventThrottle={100}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      >
        {isLoadingMore && (
          <View className="items-center py-2 mb-2">
            <ActivityIndicator size="small" />
          </View>
        )}
        {sortedMessages.length > 0 ? (
          sortedMessages.map((msg) => {
            const hasReactions = msg.reactions && msg.reactions.length > 0;
            const hasAttachments = msg.attachments && msg.attachments.length > 0;
            const hasText =
              msg.content &&
              msg.content.trim().length > 0 &&
              !(hasAttachments && msg.content.trim() === "[attachment]");

            return (
              <View
                key={msg._id}
                className={cn(
                  "w-full",
                  msg.isFromMe ? "items-end" : "items-start",
                  hasReactions && "mb-2",
                )}
              >
                {!msg.isFromMe && msg.senderName && (
                  <Text className="text-xs font-medium text-muted-foreground mb-1 ml-1">
                    {msg.senderName}
                  </Text>
                )}
                <View
                  className={cn(
                    "relative rounded-2xl px-4 py-2 max-w-[85%]",
                    msg.isFromMe ? "bg-primary" : "bg-muted",
                  )}
                >
                  {hasReactions && (
                    <ReactionBadges
                      reactions={msg.reactions!}
                      isSent={msg.isFromMe}
                    />
                  )}
                  {hasAttachments && (
                    <AttachmentDisplay attachments={msg.attachments!} mutedColor={colors.mutedForeground} />
                  )}
                  {hasText && msg.content && (
                    <Text
                      className={cn(
                        "text-sm",
                        msg.isFromMe ? "text-primary-foreground" : "text-foreground",
                      )}
                      selectable
                    >
                      {platform === "slack"
                        ? parseSlackContent(msg.content, msg.isFromMe ? "text-primary-foreground" : "text-foreground")
                        : msg.content}
                    </Text>
                  )}
                  {!hasText && !hasAttachments && (
                    <Text className="text-sm text-muted-foreground">
                      [No text]
                    </Text>
                  )}
                  <View
                    className={cn(
                      "flex-row items-center gap-1 mt-1",
                      msg.isFromMe ? "justify-end" : "justify-start",
                    )}
                  >
                    <Text
                      className={cn(
                        "text-[10px]",
                        msg.isFromMe ? "text-primary-foreground/60" : "text-muted-foreground",
                      )}
                    >
                      {formatTime(msg.sentAt)}
                    </Text>
                    {msg.isFromMe && (
                      <>
                        <Text
                          className={cn(
                            "text-[10px] mx-0.5",
                            msg.isFromMe ? "text-primary-foreground/60" : "text-muted-foreground",
                          )}
                        >
                          ·
                        </Text>
                        <DeliveryStatus status={msg.status} />
                      </>
                    )}
                  </View>
                </View>
              </View>
            );
          })
        ) : (
          <View className="flex-1 items-center justify-center">
            <Text className="text-muted-foreground">No recent messages</Text>
          </View>
        )}
      </ScrollView>

      {/* Response Input or Completed State */}
      {showDesktopOfflineWarning && (
        <View className="px-4 pb-2">
          <Text className="text-xs text-muted-foreground">
            Desktop offline. Messages stay queued until desktop reconnects.
          </Text>
        </View>
      )}
      {isCompleted ? (
        <View className="px-4 py-4 items-center justify-center flex-row gap-2">
          <SymbolView name="checkmark.circle.fill" size={18} tintColor="#1B5E3D" />
          <Text className="text-sm font-medium text-muted-foreground">
            Message queued
          </Text>
        </View>
      ) : (
        <ChatInput
          value={responseText}
          onChangeText={onResponseChange}
          onSubmit={onSend}
          placeholder="Message..."
          disableKeyboardHandling
          insideGlassContainer
        />
      )}
    </View>
  );
}

export default MessageResponseCard;
