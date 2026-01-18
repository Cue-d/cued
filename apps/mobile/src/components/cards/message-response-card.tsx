/**
 * MessageResponseCard component for mobile action queue.
 *
 * Task 6.1: Create header with Avatar, person name, relative timestamp, platform badge
 * Task 6.2: Message bubbles (will implement later)
 * Task 6.3: Response input (will implement later)
 */

import { useMemo, useRef, useCallback } from "react";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { View, Text, ScrollView, TextInput, useColorScheme } from "react-native";
import type { ScrollView as ScrollViewType } from "react-native";
import { Image } from "expo-image";
import { cn, getThemeColors } from "@/lib/utils";

/** Platform types */
export type ActionPlatform = "imessage" | "gmail" | "slack";

/** Platform config for display */
const platformConfig: Record<
  ActionPlatform,
  { label: string; symbol: SFSymbol; colorClass: string }
> = {
  imessage: {
    label: "iMessage",
    symbol: "message.fill",
    colorClass: "text-green-600",
  },
  gmail: {
    label: "Gmail",
    symbol: "envelope.fill",
    colorClass: "text-red-600",
  },
  slack: {
    label: "Slack",
    symbol: "number",
    colorClass: "text-purple-600",
  },
};

/** Message attachment with URL */
export interface MessageAttachment {
  filename: string | null;
  mimeType: string | null;
  url: string | null;
  thumbnailUrl?: string | null;
}

/** Message data shape for display */
export interface DisplayMessage {
  _id: string;
  content: string | null;
  sentAt: number;
  isFromMe: boolean;
  senderName: string | null;
  status?: string | null;
  reactions?: string[] | null;
  attachments?: MessageAttachment[] | null;
}

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

/** Format timestamp to time string */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

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

/** Platform colors */
const platformColors: Record<ActionPlatform, string> = {
  imessage: "#16a34a", // green-600
  gmail: "#dc2626", // red-600
  slack: "#9333ea", // purple-600
};

/** Platform badge component */
function PlatformBadge({
  platform,
}: {
  platform: ActionPlatform;
}): React.JSX.Element {
  const config = platformConfig[platform];
  return (
    <View className="flex-row items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-card">
      <SymbolView
        name={config.symbol}
        size={14}
        tintColor={platformColors[platform]}
      />
      <Text className="text-xs font-medium text-foreground">{config.label}</Text>
    </View>
  );
}

/** Delivery status indicator */
function DeliveryStatus({
  status,
}: {
  status?: string | null;
}): React.JSX.Element | null {
  if (status === "failed") {
    return (
      <Text className="text-red-500 text-[10px]" accessibilityLabel="Failed to send">
        !
      </Text>
    );
  }
  if (status === "read") {
    return (
      <Text className="text-blue-400 text-[10px]" accessibilityLabel="Read">
        Read
      </Text>
    );
  }
  if (status === "delivered") {
    return (
      <Text className="text-muted-foreground text-[10px]" accessibilityLabel="Delivered">
        Delivered
      </Text>
    );
  }
  return (
    <Text className="text-muted-foreground text-[10px]" accessibilityLabel="Sent">
      Sent
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
}: MessageResponseCardProps): React.JSX.Element {
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");
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

        {/* Platform Badge */}
        {platform && <PlatformBadge platform={platform} />}
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
                        msg.isFromMe ? "text-white" : "text-foreground",
                      )}
                      selectable
                    >
                      {msg.content}
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
      <View className="p-4 bg-transparent">
        {isLiquidGlassAvailable() ? (
          <GlassView
            style={{
              borderRadius: 16,
              minHeight: 80,
            }}
          >
            <View className="flex-row items-start p-3 gap-2">
              <SymbolView name="plus" size={18} tintColor={colors.mutedForeground} />
              <TextInput
                value={responseText}
                onChangeText={onResponseChange}
                placeholder="Message..."
                placeholderTextColorClassName="accent-muted-foreground"
                multiline
                className="flex-1 text-foreground text-sm min-h-[60px] max-h-[120px]"
                accessibilityLabel="Response input"
                accessibilityHint="Type your response, swipe left to send"
              />
              <SymbolView name="mic" size={18} tintColor={colors.mutedForeground} />
            </View>
          </GlassView>
        ) : (
          <View className="flex-row items-start bg-muted/50 rounded-2xl p-3 gap-2 border border-border">
            <SymbolView name="plus" size={18} tintColor={colors.mutedForeground} />
            <TextInput
              value={responseText}
              onChangeText={onResponseChange}
              placeholder="Message..."
              placeholderTextColorClassName="accent-muted-foreground"
              multiline
              className="flex-1 text-foreground text-sm min-h-[60px] max-h-[120px]"
              accessibilityLabel="Response input"
              accessibilityHint="Type your response, swipe left to send"
            />
            <SymbolView name="mic" size={18} tintColor={colors.mutedForeground} />
          </View>
        )}
      </View>
    </View>
  );
}

export default MessageResponseCard;
