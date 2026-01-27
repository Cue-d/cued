/**
 * MessageResponseCard component for mobile action queue.
 *
 * Task 6.1: Create header with Avatar, person name, relative timestamp, platform badge
 * Task 6.2: Message bubbles (will implement later)
 * Task 6.3: Response input (will implement later)
 */

import { useMemo, useRef, useCallback } from "react";
import { View, Text, ScrollView } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import {
  getInitials,
  formatTime,
  formatRelativeTime,
  PLATFORM_CONFIG,
  type ActionPlatform,
  type DisplayMessage,
} from "@prm/shared";
import { ChatInput } from "@/components/chat/chat-input";
import { cn } from "@/lib/utils";
import type { ScrollView as ScrollViewType } from "react-native";

/** Platform icons (platform-specific SF Symbols) */
const PLATFORM_SYMBOLS: Record<ActionPlatform, SFSymbol> = {
  imessage: "message.fill",
  gmail: "envelope.fill",
  slack: "number",
  linkedin: "person.2.fill",
  twitter: "bird.fill",
  signal: "phone.fill",
  whatsapp: "phone.fill",
};

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
}

/** Avatar component with initials */
function Avatar({
  initials,
  className,
}: {
  initials: string;
  className?: string;
}): React.JSX.Element {
  return (
    <View
      className={cn(
        "w-10 h-10 rounded-full bg-muted items-center justify-center",
        className,
      )}
    >
      <Text className="text-foreground font-semibold text-sm">{initials}</Text>
    </View>
  );
}

/** Platform badge component */
function PlatformBadge({
  platform,
}: {
  platform: ActionPlatform;
}): React.JSX.Element {
  const config = PLATFORM_CONFIG[platform];
  return (
    <View className="flex-row items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-card">
      <SymbolView
        name={PLATFORM_SYMBOLS[platform]}
        size={14}
        tintColor={config.color}
      />
      <Text className="text-xs font-medium text-foreground">{config.label}</Text>
    </View>
  );
}

/** Status display config */
const STATUS_CONFIG: Record<string, { text: string; className: string }> = {
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
}: MessageResponseCardProps): React.JSX.Element {
  const initials = getInitials(personName);
  const scrollViewRef = useRef<ScrollViewType>(null);

  // Sort messages chronologically (oldest first)
  const sortedMessages = useMemo(
    () => [...messages].sort((a, b) => a.sentAt - b.sentAt),
    [messages],
  );

  // Scroll to bottom when content changes
  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: false });
    }, 50);
  }, []);

  return (
    <View className={cn("flex-1 overflow-hidden", className)}>
      {/* Header */}
      <View className="p-4 flex-row items-center gap-3">
        <Avatar initials={initials} />
        <View className="flex-1 min-w-0">
          <Text
            className="font-semibold text-sm text-foreground"
            numberOfLines={1}
          >
            {personName}
          </Text>
          {messageTimestamp && (
            <Text className="text-xs text-muted-foreground">
              {formatRelativeTime(messageTimestamp)}
            </Text>
          )}
        </View>

        {/* Platform Badge + Desktop Status */}
        <View className="flex-row items-center gap-2">
          {platform === "imessage" && isDesktopOnline !== undefined && (
            <View className="flex-row items-center gap-1.5">
              <View
                className={`w-2 h-2 rounded-full ${isDesktopOnline ? "bg-green-500" : "bg-muted-foreground"}`}
              />
              <Text className="text-xs text-muted-foreground">
                {isDesktopOnline ? "Online" : "Offline"}
              </Text>
            </View>
          )}
          {platform && <PlatformBadge platform={platform} />}
        </View>
      </View>

      {/* Message Context */}
      <ScrollView
        ref={scrollViewRef}
        className="flex-1"
        contentContainerClassName="py-4 px-4 gap-2"
        onLayout={scrollToBottom}
        onContentSizeChange={scrollToBottom}
      >
        {sortedMessages.length > 0 ? (
          sortedMessages.map((msg) => {
            const hasReactions = msg.reactions && msg.reactions.length > 0;
            const hasText = msg.content && msg.content.trim().length > 0;

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
                  {hasText && msg.content && (
                    <Text
                      className={cn(
                        "text-sm",
                        msg.isFromMe ? "text-white" : "text-foreground",
                      )}
                      selectable
                    >
                      {msg.content}
                    </Text>
                  )}
                  {!hasText && (
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
                        msg.isFromMe ? "text-white/60" : "text-muted-foreground",
                      )}
                    >
                      {formatTime(msg.sentAt)}
                    </Text>
                    {msg.isFromMe && (
                      <>
                        <Text
                          className={cn(
                            "text-[10px] mx-0.5",
                            msg.isFromMe ? "text-white/60" : "text-muted-foreground",
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

      {/* Response Input - Liquid Glass Style */}
      <ChatInput
        value={responseText}
        onChangeText={onResponseChange}
        placeholder="Message..."
        disableKeyboardHandling
        insideGlassContainer
      />
    </View>
  );
}

export default MessageResponseCard;
