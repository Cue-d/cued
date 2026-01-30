/**
 * Snooze picker sheet for snoozing actions.
 * Presents as a form sheet with preset snooze times and custom date picker.
 * Calls mutation directly and uses router.back() to dismiss.
 */

import { useState, useCallback } from "react";
import { View, Text, Pressable, useColorScheme } from "react-native";
import { GlassView } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import DateTimePicker from "@react-native-community/datetimepicker";
import { useMutation } from "convex/react";
import { api } from "@cued/convex/convex/_generated/api";
import { getThemeColors } from "@/lib/utils";
import type { Id } from "@cued/convex/convex/_generated/dataModel";
import type { StyleProp, ViewStyle } from "react-native";
import type { SFSymbol } from "sf-symbols-typescript";

/** Shared style for GlassView rows */
const GLASS_ROW_STYLE: StyleProp<ViewStyle> = {
  flexDirection: "row",
  alignItems: "center",
  padding: 16,
  borderRadius: 12,
  gap: 12,
};

/** Reusable row component for snooze options */
function SnoozeRow({
  label,
  icon,
  iconColor,
  onPress,
}: {
  label: string;
  icon: SFSymbol;
  iconColor: string;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable onPress={onPress}>
      <GlassView isInteractive style={GLASS_ROW_STYLE}>
        <Text className="flex-1 text-foreground text-base" numberOfLines={1}>
          {label}
        </Text>
        <SymbolView name={icon} size={16} tintColor={iconColor} />
      </GlassView>
    </Pressable>
  );
}

/** Snooze preset with label and timestamp calculator */
interface SnoozePreset {
  label: string;
  getTimestamp: () => number;
}

/** Calculate tomorrow at 9am */
function getTomorrow9am(): number {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}

/** Calculate days until next Monday */
function getDaysUntilMonday(dayOfWeek: number): number {
  switch (dayOfWeek) {
    case 0: return 1;  // Sunday -> tomorrow
    case 1: return 7;  // Monday -> next Monday
    default: return 8 - dayOfWeek; // Tue-Sat
  }
}

/** Calculate next Monday at 9am */
function getNextMonday9am(): number {
  const date = new Date();
  const daysUntilMonday = getDaysUntilMonday(date.getDay());
  date.setDate(date.getDate() + daysUntilMonday);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}

/** Preset snooze options */
const SNOOZE_PRESETS: SnoozePreset[] = [
  {
    label: "1 hour",
    getTimestamp: () => Date.now() + 60 * 60 * 1000,
  },
  {
    label: "3 hours",
    getTimestamp: () => Date.now() + 3 * 60 * 60 * 1000,
  },
  {
    label: "Tomorrow 9am",
    getTimestamp: getTomorrow9am,
  },
  {
    label: "Next Monday 9am",
    getTimestamp: getNextMonday9am,
  },
];

export default function SnoozePicker(): React.JSX.Element {
  const router = useRouter();
  const { actionId } = useLocalSearchParams<{ actionId: string }>();
  const swipeAction = useMutation(api.actions.swipeAction);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [customDate, setCustomDate] = useState(new Date());
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");

  /** Snooze the action and dismiss the sheet */
  const snoozeAndDismiss = useCallback(
    async (timestamp: number) => {
      if (!actionId) return;

      try {
        await swipeAction({
          actionId: actionId as Id<"actions">,
          direction: "up",
          snoozedUntil: timestamp,
        });
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (error) {
        console.error("Failed to snooze action:", error);
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }

      router.back();
    },
    [actionId, swipeAction, router],
  );

  /** Handle preset selection */
  const handlePresetSelect = useCallback(
    (preset: SnoozePreset) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      snoozeAndDismiss(preset.getTimestamp());
    },
    [snoozeAndDismiss],
  );

  /** Handle custom date selection */
  const handleCustomDateChange = useCallback(
    (_event: unknown, selectedDate?: Date) => {
      if (selectedDate) {
        setCustomDate(selectedDate);
      }
    },
    [],
  );

  /** Confirm custom date */
  const handleConfirmCustom = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    snoozeAndDismiss(customDate.getTime());
  }, [snoozeAndDismiss, customDate]);

  /** Toggle custom picker visibility */
  const toggleCustomPicker = useCallback(() => {
    Haptics.selectionAsync();
    setShowDatePicker((prev) => !prev);
  }, []);

  return (
    <View className="flex-1 p-4">
      <Text className="text-foreground text-xl font-bold text-center mb-6">
        Remind me later
      </Text>

      {/* Preset and custom buttons */}
      <View className="gap-3">
        {SNOOZE_PRESETS.map((preset) => (
          <SnoozeRow
            key={preset.label}
            label={preset.label}
            icon="chevron.right"
            iconColor={colors.mutedForeground}
            onPress={() => handlePresetSelect(preset)}
          />
        ))}
        <SnoozeRow
          label="Custom..."
          icon={showDatePicker ? "chevron.up" : "chevron.down"}
          iconColor={colors.mutedForeground}
          onPress={toggleCustomPicker}
        />

        {/* Date/time picker */}
        {showDatePicker && (
          <View className="mt-2 items-center">
            <DateTimePicker
              value={customDate}
              mode="datetime"
              display="spinner"
              minimumDate={new Date()}
              onChange={handleCustomDateChange}
              themeVariant={colorScheme === "dark" ? "dark" : "light"}
            />
            <Pressable
              onPress={handleConfirmCustom}
              className="mt-4 bg-primary px-8 py-3 rounded-full"
            >
              <Text className="text-white font-semibold text-base">
                Confirm
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}
