/**
 * ActionListRow - A single action row for the queue list.
 *
 * Shows platform badge, contact name, action type, and relative time.
 * Wrapped in ContextMenu for long-press Send/Skip/Snooze actions.
 */

import { View, Text, Pressable, useColorScheme } from "react-native";
import { SymbolView } from "expo-symbols";
import { ContextMenu, Button, Host } from "@expo/ui/swift-ui";
import { PLATFORM_CONFIG, formatRelativeTime, type ActionPlatform, type EnrichedAction } from "@cued/shared";
import { PlatformIcon } from "@/components/platform-icons";
import { getThemeColors } from "@/lib/utils";

/** Human-readable labels for action types */
const ACTION_TYPE_DISPLAY: Record<string, string> = {
  respond: "Respond",
  follow_up: "Follow up",
  send_message: "Send message",
  eod_contact: "End of day review",
  new_connection: "New connection",
};

export interface ActionListRowProps {
  action: EnrichedAction;
  onPress: (actionId: string) => void;
  onSend: (actionId: string) => void;
  onSkip: (actionId: string) => void;
  onSnooze: (actionId: string) => void;
}

export function ActionListRow({
  action,
  onPress,
  onSend,
  onSkip,
  onSnooze,
}: ActionListRowProps): React.JSX.Element {
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");
  const platform = action.platform as ActionPlatform | undefined;
  const platformConfig = platform ? PLATFORM_CONFIG[platform] : null;
  const contactName = action.contactName ?? "Unknown";
  const typeLabel =
    action.summary?.trim() ||
    ACTION_TYPE_DISPLAY[action.type] ||
    action.type;
  const timeAgo = formatRelativeTime(action.createdAt);

  return (
    <Host>
    <ContextMenu>
      <ContextMenu.Trigger>
        <Pressable
          onPress={() => onPress(action._id)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 16,
            paddingVertical: 12,
            gap: 12,
          }}
        >
          {/* Platform badge */}
          <View
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              backgroundColor: platformConfig ? `${platformConfig.color}15` : (colorScheme === "dark" ? "#2A2A2A" : "#F3F4F6"),
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {platform ? (
              <PlatformIcon platform={platform} size={18} />
            ) : (
              <SymbolView name="questionmark" size={16} tintColor={colors.mutedForeground} />
            )}
          </View>

          {/* Content */}
          <View style={{ flex: 1, gap: 2 }}>
            <Text
              style={{ fontSize: 15, fontWeight: "600", color: colors.foreground }}
              numberOfLines={1}
            >
              {contactName}
            </Text>
            <Text
              style={{ fontSize: 13, color: colors.mutedForeground }}
              numberOfLines={1}
            >
              {typeLabel} · {timeAgo}
            </Text>
          </View>

          {/* Chevron */}
          <SymbolView name="chevron.right" size={12} tintColor={colors.mutedForeground} weight="semibold" />
        </Pressable>
      </ContextMenu.Trigger>

      <ContextMenu.Items>
        <Button
          label="Send"
          systemImage="paperplane.fill"
          onPress={() => onSend(action._id)}
        />
        <Button
          label="Skip"
          systemImage="xmark"
          onPress={() => onSkip(action._id)}
        />
        <Button
          label="Snooze"
          systemImage="clock"
          onPress={() => onSnooze(action._id)}
        />
      </ContextMenu.Items>
    </ContextMenu>
    </Host>
  );
}
