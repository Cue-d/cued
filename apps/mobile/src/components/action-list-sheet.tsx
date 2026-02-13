/**
 * ActionListSheet - Content for the action queue bottom sheet.
 *
 * Shows a filterable list of all pending actions with context menu
 * actions, and queued/sending messages at the bottom with undo.
 */

import { useCallback, useState, useEffect } from "react";
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

/** Hook to get a live countdown from a scheduledFor timestamp */
function useCountdown(scheduledFor: number): number {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, scheduledFor - Date.now()),
  );
  useEffect(() => {
    if (remaining <= 0) return;
    const interval = setInterval(() => {
      const next = Math.max(0, scheduledFor - Date.now());
      setRemaining(next);
      if (next <= 0) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
  }, [scheduledFor, remaining]);
  return remaining;
}

/** Status label for a queued message */
function MessageStatus({
  remainingMs,
  isDark,
}: {
  remainingMs: number;
  isDark: boolean;
}): React.JSX.Element {
  const colors = getThemeColors(isDark);
  if (remainingMs <= 0) {
    return (
      <Text
        style={{
          fontSize: 11,
          fontWeight: "600",
          color: colors.mutedForeground,
        }}
      >
        Sent
      </Text>
    );
  }
  const seconds = Math.ceil(remainingMs / 1000);
  return (
    <Text
      style={{
        fontSize: 11,
        fontWeight: "600",
        color: colors.mutedForeground,
        fontVariant: ["tabular-nums"],
      }}
    >
      {seconds}s
    </Text>
  );
}

/** Queued message row (at bottom of sheet) */
function QueuedMessageRow({
  messageId,
  platform,
  recipientName,
  messagePreview,
  scheduledFor,
  onUndo,
  onDismiss,
  isDark,
}: {
  messageId: string;
  platform: ActionPlatform;
  recipientName: string;
  messagePreview?: string;
  scheduledFor: number;
  onUndo: (messageId: string) => void;
  onDismiss: (messageId: string) => void;
  isDark: boolean;
}): React.JSX.Element {
  const colors = getThemeColors(isDark);
  const remainingMs = useCountdown(scheduledFor);
  const isPending = remainingMs > 0;

  // Auto-dismiss 2s after countdown expires
  useEffect(() => {
    if (isPending) return;
    const timeout = setTimeout(() => onDismiss(messageId), 2000);
    return () => clearTimeout(timeout);
  }, [isPending, messageId, onDismiss]);

  const preview = messagePreview
    ? messagePreview.length > 40
      ? `${messagePreview.slice(0, 40)}…`
      : messagePreview
    : "";

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 16,
        paddingVertical: 10,
        gap: 10,
      }}
    >
      {/* Platform icon */}
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 14,
          backgroundColor: `${PLATFORM_CONFIG[platform].color}15`,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <PlatformIcon platform={platform} size={14} />
      </View>

      {/* Content: ContactName: "message..." */}
      <View style={{ flex: 1 }}>
        <Text
          style={{ fontSize: 13, fontWeight: "500", color: colors.foreground }}
          numberOfLines={1}
        >
          {preview ? `${recipientName}: "${preview}"` : recipientName}
        </Text>
      </View>

      {/* Countdown / status */}
      <MessageStatus remainingMs={remainingMs} isDark={isDark} />

      {/* Undo button (only while pending) */}
      {isPending && (
        <Pressable
          onPress={() => onUndo(messageId)}
          style={{
            paddingHorizontal: 12,
            paddingVertical: 5,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: isDark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.1)",
          }}
        >
          <Text
            style={{
              fontSize: 12,
              fontWeight: "600",
              color: colors.foreground,
            }}
          >
            Undo
          </Text>
        </Pressable>
      )}
    </View>
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
    queuedMessages,
    handleUndoMessage,
    handleToastDismiss,
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

      {/* Queued messages - fixed at bottom above actions */}
      {queuedMessages.length > 0 && (
        <View
          style={{
            borderBottomWidth: 1,
            borderBottomColor: isDark
              ? "rgba(255,255,255,0.08)"
              : "rgba(0,0,0,0.06)",
            paddingBottom: 4,
          }}
        >
          <Text
            style={{
              fontSize: 12,
              fontWeight: "600",
              color: colors.mutedForeground,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              paddingHorizontal: 16,
              paddingTop: 4,
              paddingBottom: 4,
              marginBottom: 6,
            }}
          >
            Pending
          </Text>
          {queuedMessages.map((msg) => (
            <QueuedMessageRow
              key={msg.messageId}
              messageId={msg.messageId}
              platform={msg.platform}
              recipientName={msg.recipientName}
              messagePreview={msg.messagePreview}
              scheduledFor={msg.scheduledFor}
              onUndo={handleUndoMessage}
              onDismiss={(id) => handleToastDismiss(id, "sent")}
              isDark={isDark}
            />
          ))}
        </View>
      )}

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
