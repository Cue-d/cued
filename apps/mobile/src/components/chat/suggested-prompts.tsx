/**
 * SuggestedPrompts - Empty state with animated prompt suggestions
 *
 * Features:
 * - Centered sparkle icon with gradient
 * - Title and subtitle text
 * - Staggered fade-in animations for prompts
 * - GlassView chips with interactive tap effect
 * - Haptic feedback on selection
 */

import { Platform, useColorScheme, View, Text, Pressable } from "react-native";
import { SymbolView } from "expo-symbols";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import Animated, { FadeInDown, FadeIn } from "react-native-reanimated";
import { getThemeColors } from "@/lib/utils";


const SUGGESTED_PROMPTS = [
  "Who did I talk to recently?",
  "Any messages I should reply to?",
  "What's new with my contacts?",
] as const;

export interface SuggestedPromptsProps {
  onSelect: (prompt: string) => void;
}

function PromptChip({
  prompt,
  onPress,
  index,
}: {
  prompt: string;
  onPress: () => void;
  index: number;
}) {
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");

  const handlePress = () => {
    if (Platform.OS === "ios") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    onPress();
  };

  // Use GlassView on iOS 26+ for liquid glass effect
  if (isLiquidGlassAvailable()) {
    return (
      <Animated.View
        entering={FadeInDown.delay(300 + index * 80).springify().damping(20)}
      >
        <GlassView isInteractive style={{ borderRadius: 24, overflow: "hidden" }}>
          <Pressable
            onPress={handlePress}
            accessibilityRole="button"
            accessibilityLabel={prompt}
            style={{ minHeight: 44 }}
          >
            <View className="py-3 px-4">
              <Text className="text-foreground text-[16px]">{prompt}</Text>
            </View>
          </Pressable>
        </GlassView>
      </Animated.View>
    );
  }

  // Fallback with animation - more polished look
  return (
    <Animated.View
      entering={FadeInDown.delay(300 + index * 80).springify().damping(20)}
    >
      <Pressable
        onPress={handlePress}
        className="active:scale-[0.98] active:opacity-80"
        accessibilityRole="button"
        accessibilityLabel={prompt}
        style={{ minHeight: 44 }}
      >
        <View
          className="py-3 px-4 rounded-2xl"
          style={{ backgroundColor: colors.secondaryBackground }}
        >
          <Text className="text-foreground text-[16px]">{prompt}</Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

export function SuggestedPrompts({ onSelect }: SuggestedPromptsProps) {
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");

  return (
    <View className="px-5">
      {/* Header with sparkle icon */}
      <Animated.View
        entering={FadeIn.delay(100).duration(400)}
        className="items-center mb-8"
      >
        <View
          className="w-16 h-16 rounded-full items-center justify-center mb-4"
          style={{ backgroundColor: colors.secondaryBackground }}
        >
          <SymbolView
            name="sparkles"
            size={28}
            weight="medium"
            tintColor={colors.mutedForeground}
          />
        </View>
        <Text
          className="text-foreground text-xl font-semibold mb-1"
          accessibilityRole="header"
        >
          Ask anything
        </Text>
        <Text className="text-muted-foreground text-[15px] text-center">
          Search contacts, messages, or get relationship insights
        </Text>
      </Animated.View>

      {/* Prompt chips */}
      <View className="gap-3">
        {SUGGESTED_PROMPTS.map((prompt, index) => (
          <PromptChip
            key={prompt}
            prompt={prompt}
            index={index}
            onPress={() => onSelect(prompt)}
          />
        ))}
      </View>
    </View>
  );
}
