/**
 * SuggestedPrompts - Vertical animated prompt suggestions for agent chat
 *
 * Features:
 * - Pre-defined prompts for common queries
 * - Staggered fade-in animations
 * - GlassView chips with interactive tap effect
 * - Haptic feedback on selection
 *
 * Based on expo-ai FirstSuggestions design
 */

import { Platform } from "react-native";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import Animated, { FadeInDown } from "react-native-reanimated";

import { View, Text, Pressable } from "react-native";

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
  const handlePress = () => {
    if (Platform.OS === "ios") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    onPress();
  };

  const chipContent = (
    <View className="rounded-full bg-card border border-border p-2 px-3">
      <Text className="text-foreground text-[16px]">{prompt}</Text>
    </View>
  );

  // Use GlassView on iOS 26+ for liquid glass effect
  if (isLiquidGlassAvailable()) {
    return (
      <Animated.View
        entering={FadeInDown.delay((SUGGESTED_PROMPTS.length - 1 - index) * 100)}
      >
        <GlassView isInteractive className="rounded-2xl rounded-bl-[4px]">
          <Pressable onPress={handlePress} accessibilityRole="button">
            <View className="p-2 px-3">
              <Text className="text-foreground text-[16px]">{prompt}</Text>
            </View>
          </Pressable>
        </GlassView>
      </Animated.View>
    );
  }

  // Fallback with animation
  return (
    <Animated.View
      entering={FadeInDown.delay((SUGGESTED_PROMPTS.length - 1 - index) * 100)}
    >
      <Pressable
        onPress={handlePress}
        className="active:opacity-70"
        accessibilityRole="button"
      >
        {chipContent}
      </Pressable>
    </Animated.View>
  );
}

export function SuggestedPrompts({ onSelect }: SuggestedPromptsProps) {
  return (
    <View className="flex-col items-start gap-2 px-4">
      {SUGGESTED_PROMPTS.map((prompt, index) => (
        <PromptChip
          key={prompt}
          prompt={prompt}
          index={index}
          onPress={() => onSelect(prompt)}
        />
      ))}
    </View>
  );
}
