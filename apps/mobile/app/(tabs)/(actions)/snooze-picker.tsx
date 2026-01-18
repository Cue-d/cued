/**
 * Snooze picker sheet for snoozeing actions.
 *
 * Task 7.3: Create snooze picker sheet route.
 * Presents as a form sheet with preset snooze times and custom date picker.
 */

import { useState, useCallback } from "react";
import DateTimePicker from "@react-native-community/datetimepicker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { GlassView } from "expo-glass-effect";
import { View, Text, Pressable, useColorScheme } from "react-native";
import { getThemeColors } from "@/lib/utils";

/** Snooze preset with label and timestamp calculator */
interface SnoozePreset {
  label: string;
  icon: string;
  getTimestamp: () => number;
}

/** Calculate tomorrow at 9am */
function getTomorrow9am(): number {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}

/** Calculate next Monday at 9am */
function getNextMonday9am(): number {
  const date = new Date();
  const day = date.getDay();
  // Days until Monday (if today is Monday, go to next Monday)
  const daysUntilMonday = day === 0 ? 1 : day === 1 ? 7 : 8 - day;
  date.setDate(date.getDate() + daysUntilMonday);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}

/** Preset snooze options */
const SNOOZE_PRESETS: SnoozePreset[] = [
  {
    label: "1 hour",
    icon: "clock",
    getTimestamp: () => Date.now() + 60 * 60 * 1000,
  },
  {
    label: "3 hours",
    icon: "clock.badge.3",
    getTimestamp: () => Date.now() + 3 * 60 * 60 * 1000,
  },
  {
    label: "Tomorrow 9am",
    icon: "sunrise",
    getTimestamp: getTomorrow9am,
  },
  {
    label: "Next Monday 9am",
    icon: "calendar",
    getTimestamp: getNextMonday9am,
  },
];

export default function SnoozePicker(): React.JSX.Element {
  const router = useRouter();
  const { actionId } = useLocalSearchParams<{ actionId: string }>();
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [customDate, setCustomDate] = useState(new Date());
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");

  /** Handle preset selection */
  const handlePresetSelect = useCallback(
    (preset: SnoozePreset) => {
      const timestamp = preset.getTimestamp();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      // Navigate back to index with selected timestamp
      router.replace({
        pathname: "/(actions)",
        params: {
          snoozedUntil: timestamp.toString(),
          snoozeActionId: actionId ?? "",
        },
      });
    },
    [router, actionId],
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
    // Navigate back to index with selected timestamp
    router.replace({
      pathname: "/(actions)",
      params: {
        snoozedUntil: customDate.getTime().toString(),
        snoozeActionId: actionId ?? "",
      },
    });
  }, [router, actionId, customDate]);

  /** Toggle custom picker visibility */
  const toggleCustomPicker = useCallback(() => {
    Haptics.selectionAsync();
    setShowDatePicker((prev) => !prev);
  }, []);

  return (
    <View className="flex-1 p-4">
      <Text className="text-sf-label text-xl font-bold text-center mb-6">
        Snooze Until
      </Text>

      {/* Preset buttons */}
      <View className="gap-3">
        {SNOOZE_PRESETS.map((preset) => (
          <Pressable
            key={preset.label}
            onPress={() => handlePresetSelect(preset)}
          >
            <GlassView
              isInteractive
              style={{
                flexDirection: "row",
                alignItems: "center",
                padding: 16,
                borderRadius: 12,
                gap: 12,
              }}
            >
              <SymbolView
                name={preset.icon as never}
                size={24}
                tintColor={colors.info}
              />
              <Text className="text-sf-label text-base flex-1">
                {preset.label}
              </Text>
              <SymbolView
                name="chevron.right"
                size={16}
                tintColor={colors.mutedForeground}
              />
            </GlassView>
          </Pressable>
        ))}

        {/* Custom date option */}
        <Pressable onPress={toggleCustomPicker}>
          <GlassView
            isInteractive
            style={{
              flexDirection: "row",
              alignItems: "center",
              padding: 16,
              borderRadius: 12,
              gap: 12,
            }}
          >
            <SymbolView
              name="calendar.badge.clock"
              size={24}
              tintColor={colors.info}
            />
            <Text className="text-sf-label text-base flex-1">Custom...</Text>
            <SymbolView
              name={showDatePicker ? "chevron.up" : "chevron.down"}
              size={16}
              tintColor={colors.mutedForeground}
            />
          </GlassView>
        </Pressable>

        {/* Date/time picker */}
        {showDatePicker && (
          <View className="mt-2 items-center">
            <DateTimePicker
              value={customDate}
              mode="datetime"
              display="spinner"
              minimumDate={new Date()}
              onChange={handleCustomDateChange}
              themeVariant="dark"
            />
            <Pressable
              onPress={handleConfirmCustom}
              className="mt-4 bg-sf-blue px-8 py-3 rounded-full"
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
