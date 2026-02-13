/**
 * ActionListSheet - Content for the action queue bottom sheet.
 *
 * Shows a filterable list of all pending actions with context menu
 * actions.
 */

import { useCallback } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  useColorScheme,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { useMutation } from "convex/react";
import { api } from "@cued/convex";
import { PLATFORM_CONFIG, type ActionPlatform } from "@cued/shared";
import {
  useActionQueue,
  type PlatformFilter,
  type ActionTypeFilter,
} from "@/contexts/action-queue-context";
import { getThemeColors } from "@/lib/utils";
import { ActionListRow } from "./action-list-row";
import { PlatformIcon } from "./platform-icons";
import type { Id } from "@cued/convex";

/** Platform filter entries */
const PLATFORM_FILTERS: {
  key: Exclude<PlatformFilter, "all">;
  platform: ActionPlatform;
}[] = [
  { key: "imessage", platform: "imessage" },
  { key: "slack", platform: "slack" },
  { key: "linkedin", platform: "linkedin" },
  { key: "twitter", platform: "twitter" },
  { key: "signal", platform: "signal" },
];

/** Action type filter entries */
const TYPE_FILTERS: {
  key: Exclude<ActionTypeFilter, "all">;
  symbol: SymbolViewProps["name"];
  color: string;
}[] = [
  { key: "respond", symbol: "arrowshape.turn.up.left.fill", color: "#007AFF" },
  { key: "followups", symbol: "clock.arrow.circlepath", color: "#FF9500" },
  { key: "contacts", symbol: "person.2.fill", color: "#AF52DE" },
];

/** Icon-based filter button */
function FilterButton({
  icon,
  isActive,
  activeColor,
  onPress,
  isDark,
}: {
  icon: React.ReactNode;
  isActive: boolean;
  activeColor?: string;
  onPress: () => void;
  isDark: boolean;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      style={{
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: isActive
          ? activeColor
            ? `${activeColor}20`
            : isDark
              ? "rgba(255,255,255,0.15)"
              : "rgba(0,0,0,0.1)"
          : isDark
            ? "rgba(255,255,255,0.06)"
            : "rgba(0,0,0,0.04)",
      }}
    >
      {icon}
    </Pressable>
  );
}

/** Vertical separator between filter groups */
function FilterSeparator({ isDark }: { isDark: boolean }): React.JSX.Element {
  return (
    <View
      style={{
        width: 1,
        height: 20,
        backgroundColor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)",
        marginHorizontal: 4,
        alignSelf: "center",
      }}
    />
  );
}

export function ActionListSheet(): React.JSX.Element {
  const router = useRouter();
  const swipeAction = useMutation(api.actions.swipeAction);
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = getThemeColors(isDark);
  const {
    filteredActions,
    platformFilter,
    setPlatformFilter,
    typeFilter,
    setTypeFilter,
    setFocusedActionId,
    setIsSheetOpen,
  } = useActionQueue();

  // Tap row → dismiss sheet first, then focus action after dismiss animation
  const handleRowPress = useCallback(
    (actionId: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setIsSheetOpen(false);
      setTimeout(() => setFocusedActionId(actionId), 350);
    },
    [setFocusedActionId, setIsSheetOpen],
  );

  // Context menu: Send
  const handleSend = useCallback(
    async (actionId: string) => {
      try {
        await swipeAction({
          actionId: actionId as Id<"actions">,
          direction: "right",
        });
        await Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        );
      } catch {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    },
    [swipeAction],
  );

  // Context menu: Skip
  const handleSkip = useCallback(
    async (actionId: string) => {
      try {
        await swipeAction({
          actionId: actionId as Id<"actions">,
          direction: "left",
        });
        await Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        );
      } catch {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    },
    [swipeAction],
  );

  // Context menu: Snooze → navigate to snooze picker
  const handleSnooze = useCallback(
    (actionId: string) => {
      setIsSheetOpen(false);
      router.push({
        pathname: "/(tabs)/(actions)/snooze-picker",
        params: { actionId },
      });
    },
    [router, setIsSheetOpen],
  );

  const hasActiveFilters = platformFilter !== "all" || typeFilter !== "all";

  return (
    <View className="flex-1">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0 }}
        contentContainerStyle={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingVertical: 10,
          marginTop: 10,
          gap: 4,
        }}
      >
        {/* Platform filters */}
        {PLATFORM_FILTERS.map((f) => {
          const isActive = platformFilter === f.key;
          const platformColor = PLATFORM_CONFIG[f.platform]?.color;
          return (
            <FilterButton
              key={f.key}
              isActive={isActive}
              activeColor={platformColor}
              onPress={() => setPlatformFilter(isActive ? "all" : f.key)}
              isDark={isDark}
              icon={
                <PlatformIcon
                  platform={f.platform}
                  size={16}
                  color={
                    isActive
                      ? platformColor
                      : isDark
                        ? "rgba(255,255,255,0.4)"
                        : "rgba(0,0,0,0.3)"
                  }
                />
              }
            />
          );
        })}

        <FilterSeparator isDark={isDark} />

        {/* Action type filters */}
        {TYPE_FILTERS.map((f) => {
          const isActive = typeFilter === f.key;
          return (
            <FilterButton
              key={f.key}
              isActive={isActive}
              activeColor={f.color}
              onPress={() => setTypeFilter(isActive ? "all" : f.key)}
              isDark={isDark}
              icon={
                <SymbolView
                  name={f.symbol}
                  size={16}
                  tintColor={
                    isActive
                      ? f.color
                      : isDark
                        ? "rgba(255,255,255,0.4)"
                        : "rgba(0,0,0,0.3)"
                  }
                />
              }
            />
          );
        })}
      </ScrollView>

      <ScrollView style={{ flex: 1 }}>
        {/* Action list */}
        {filteredActions.length === 0 ? (
          <View style={{ alignItems: "center", paddingVertical: 40 }}>
            <SymbolView
              name="tray"
              size={40}
              tintColor={colors.mutedForeground}
            />
            <Text
              style={{
                fontSize: 15,
                color: colors.mutedForeground,
                marginTop: 12,
              }}
            >
              {hasActiveFilters ? "No matching actions" : "All caught up!"}
            </Text>
          </View>
        ) : (
          filteredActions.map((item, index) => (
            <View key={item._id}>
              {index > 0 && (
                <View
                  style={{
                    height: 1,
                    backgroundColor: isDark
                      ? "rgba(255,255,255,0.08)"
                      : "rgba(0,0,0,0.06)",
                  }}
                />
              )}
              <ActionListRow
                action={item}
                onPress={handleRowPress}
                onSend={handleSend}
                onSkip={handleSkip}
                onSnooze={handleSnooze}
              />
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}
