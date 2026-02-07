/**
 * ActionQueueAccessory - "Now Playing" bar for the action queue.
 *
 * Rendered inside NativeTabs.BottomAccessory. Uses usePlacement() to
 * provide regular (full bar) and inline (compact) views.
 * Shows current top action summary and sending status.
 */

import { View, Text, TouchableOpacity, useColorScheme } from "react-native";
import { SymbolView } from "expo-symbols";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { PLATFORM_CONFIG, type ActionPlatform } from "@cued/shared";
import { PlatformIcon } from "@/components/platform-icons";
import { useActionQueue } from "@/contexts/action-queue-context";
import { getThemeColors } from "@/lib/utils";

/** Human-readable label for action types */
const ACTION_TYPE_LABELS: Record<string, string> = {
  respond: "Respond to",
  follow_up: "Follow up with",
  send_message: "Message",
  eod_contact: "Review",
  new_connection: "New contact:",
};

function getActionLabel(type: string, contactName: string): string {
  const prefix = ACTION_TYPE_LABELS[type] ?? "Action for";
  return `${prefix} ${contactName}`;
}

export function ActionQueueAccessory(): React.JSX.Element | null {
  const placement = NativeTabs.BottomAccessory.usePlacement();
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");
  const { topAction, actions, queuedMessages, setIsSheetOpen } = useActionQueue();

  // Nothing to show
  if (actions.length === 0 && queuedMessages.length === 0) {
    return null;
  }

  const topSendingMsg = queuedMessages[0];
  const sendingPlatform = topSendingMsg?.platform;
  const sendingPlatformConfig = sendingPlatform ? PLATFORM_CONFIG[sendingPlatform] : null;
  const contactName = topAction?.contactName ?? "Unknown";
  const platform = topAction?.platform as ActionPlatform | undefined;
  const platformConfig = platform ? PLATFORM_CONFIG[platform] : null;

  // Inline mode (minimized tab bar) - compact label
  if (placement === "inline") {
    const inlineLabel = topSendingMsg
      ? `Sending to ${topSendingMsg.recipientName}`
      : actions.length > 0
        ? `${actions.length} action${actions.length !== 1 ? "s" : ""}`
        : "";

    return (
      <TouchableOpacity
        className="h-8 justify-center items-center px-3"
        onPress={() => setIsSheetOpen(true)}
      >
        <Text className="text-sm font-medium text-primary" numberOfLines={1}>{inlineLabel}</Text>
      </TouchableOpacity>
    );
  }

  // Undo-send state - shows platform icon + contact: "message..."
  if (topSendingMsg) {
    const preview = topSendingMsg.messagePreview
      ? topSendingMsg.messagePreview.length > 30
        ? `${topSendingMsg.messagePreview.slice(0, 30)}…`
        : topSendingMsg.messagePreview
      : "";

    return (
      <TouchableOpacity
        className="h-full justify-center px-4"
        onPress={() => setIsSheetOpen(true)}
        activeOpacity={0.7}
      >
        <View className="flex-row items-center gap-2">
          {/* Platform icon */}
          <View
            className="w-7 h-7 rounded-full items-center justify-center"
            style={{
              backgroundColor: sendingPlatformConfig
                ? `${sendingPlatformConfig.color}15`
                : colorScheme === "dark"
                  ? "#2A2A2A"
                  : "#F3F4F6",
            }}
          >
            {sendingPlatform ? (
              <PlatformIcon platform={sendingPlatform} size={14} />
            ) : (
              <SymbolView name="paperplane" size={14} tintColor={colors.mutedForeground} />
            )}
          </View>

          {/* Contact name: "message..." */}
          <Text className="text-sm font-semibold text-foreground shrink" numberOfLines={1}>
            {preview
              ? `${topSendingMsg.recipientName}: "${preview}"`
              : topSendingMsg.recipientName}
          </Text>

          {/* Spacer */}
          <View className="flex-1" />

          {/* Queued count badge */}
          {queuedMessages.length > 1 && (
            <View className="size-6 bg-primary rounded-full justify-center bg-primary-surface items-center">
              <Text className="text-xs font-bold text-center text-primary-foreground">
                {queuedMessages.length}
              </Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    );
  }

  // Action preview state
  if (topAction) {
    const label = getActionLabel(topAction.type, contactName);

    return (
      <TouchableOpacity
        className="h-full justify-center px-4"
        onPress={() => setIsSheetOpen(true)}
        activeOpacity={0.7}
      >
        <View className="flex-row items-center gap-2">
          {/* Platform icon */}
          <View
            className="w-7 h-7 rounded-full items-center justify-center"
            style={{
              backgroundColor: platformConfig
                ? `${platformConfig.color}15`
                : colorScheme === "dark"
                  ? "#2A2A2A"
                  : "#F3F4F6",
            }}
          >
            {platform ? (
              <PlatformIcon platform={platform} size={14} />
            ) : (
              <SymbolView name="tray" size={14} tintColor={colors.mutedForeground} />
            )}
          </View>

          {/* Action label */}
          <Text className="text-sm font-semibold text-foreground shrink" numberOfLines={1}>
            {label}
          </Text>

          {/* Spacer */}
          <View className="flex-1" />

          {/* Action count */}
          {actions.length > 1 && (
            <View className="size-6 bg-primary rounded-full justify-center bg-primary-surface items-center">
              <Text className="text-xs font-bold text-center text-primary-foreground">
                {actions.length}
              </Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    );
  }

  return null;
}
