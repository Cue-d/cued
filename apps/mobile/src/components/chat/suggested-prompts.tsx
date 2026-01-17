/**
 * SuggestedPrompts - Horizontal scrolling prompt suggestions for agent chat
 *
 * Features:
 * - Pre-defined prompts for common queries
 * - Horizontal ScrollView for browsing
 * - GlassView chips with interactive tap effect
 * - Haptic feedback on selection
 */

import { Pressable } from "react-native";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";

import { View, Text, ScrollView } from "@/tw";

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
}: {
  prompt: string;
  onPress: () => void;
}) {
  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress();
  };

  // Use GlassView on iOS 26+ for liquid glass effect
  if (isLiquidGlassAvailable()) {
    return (
      <GlassView
        isInteractive
        className="rounded-full px-4 py-2.5"
      >
        <Pressable onPress={handlePress} accessibilityRole="button">
          <Text className="text-sf-label text-[15px]">{prompt}</Text>
        </Pressable>
      </GlassView>
    );
  }

  // Fallback to semi-transparent background
  return (
    <Pressable
      onPress={handlePress}
      className="rounded-full px-4 py-2.5 bg-sf-fill active:opacity-70"
      accessibilityRole="button"
    >
      <Text className="text-sf-label text-[15px]">{prompt}</Text>
    </Pressable>
  );
}

export function SuggestedPrompts({ onSelect }: SuggestedPromptsProps) {
  return (
    <View className="py-4">
      <Text className="text-sf-secondaryLabel text-sm mb-3 px-4">
        Try asking...
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-3 px-4"
      >
        {SUGGESTED_PROMPTS.map((prompt) => (
          <PromptChip
            key={prompt}
            prompt={prompt}
            onPress={() => onSelect(prompt)}
          />
        ))}
      </ScrollView>
    </View>
  );
}
