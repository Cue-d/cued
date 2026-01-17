/**
 * ChatInput - Text input component for agent chat with keyboard handling
 *
 * Features:
 * - Multiline text input
 * - Send button with SF Symbol
 * - GlassView background for liquid glass effect
 * - Disabled state when input is empty
 */

import { Pressable } from "react-native";
import { SymbolView } from "expo-symbols";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";

import { View, TextInput } from "@/tw";
import { cn } from "@/lib/utils";

export interface ChatInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
}

export function ChatInput({
  value,
  onChangeText,
  onSubmit,
  placeholder = "Message...",
  disabled = false,
}: ChatInputProps) {
  const canSubmit = value.trim().length > 0 && !disabled;

  const handleSubmit = () => {
    if (!canSubmit) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSubmit();
  };

  const inputContent = (
    <View className="flex-row items-end gap-2 px-4 py-3">
      <TextInput
        className="flex-1 text-sf-label text-[15px] min-h-[36px] max-h-[120px] py-2"
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#8E8E93"
        multiline
        returnKeyType="default"
        blurOnSubmit={false}
        editable={!disabled}
      />
      <Pressable
        onPress={handleSubmit}
        disabled={!canSubmit}
        className={cn(
          "w-9 h-9 rounded-full items-center justify-center",
          canSubmit ? "bg-sf-blue" : "bg-sf-fill"
        )}
        accessibilityLabel="Send message"
        accessibilityRole="button"
        accessibilityState={{ disabled: !canSubmit }}
      >
        <SymbolView
          name="arrow.up"
          size={18}
          tintColor={canSubmit ? "#FFFFFF" : "#8E8E93"}
        />
      </Pressable>
    </View>
  );

  // Use GlassView on iOS 26+ for liquid glass effect
  if (isLiquidGlassAvailable()) {
    return (
      <GlassView
        className="border-t border-sf-separator"
        isInteractive={false}
      >
        {inputContent}
      </GlassView>
    );
  }

  // Fallback to semi-transparent background
  return (
    <View className="border-t border-sf-separator bg-sf-secondaryBg/95">
      {inputContent}
    </View>
  );
}
