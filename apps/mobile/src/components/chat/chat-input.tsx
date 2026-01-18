/**
 * ChatInput - Text input component for agent chat with keyboard handling
 *
 * Features:
 * - Multiline text input with rounded styling
 * - Send button with SF Symbol
 * - GlassView background for liquid glass effect
 * - Keyboard-responsive animated positioning
 * - Haptic feedback on send
 */

import { SymbolView } from "expo-symbols";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import Animated, {
  useAnimatedKeyboard,
  useAnimatedStyle,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { View, TextInput, Pressable, Platform } from "react-native";
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
  const { bottom } = useSafeAreaInsets();
  const keyboard = useAnimatedKeyboard({});

  const handleSubmit = () => {
    if (!canSubmit) return;
    if (Platform.OS === "ios") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    onSubmit();
  };

  // Animate based on keyboard height
  const animatedStyle = useAnimatedStyle(() => {
    return {
      paddingBottom: Math.max(keyboard.height.value, bottom),
    };
  }, [bottom]);

  const inputContent = (
    <View className="flex-row items-end gap-3 px-4 py-3">
      <View className="flex-1 flex-row items-end bg-secondary rounded-[20px] px-4 py-2">
        <TextInput
          className="flex-1 text-foreground text-[16px] min-h-[24px] max-h-[120px]"
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor="#8E8E93"
          multiline
          returnKeyType="send"
          blurOnSubmit={false}
          editable={!disabled}
          onSubmitEditing={handleSubmit}
        />
      </View>
      <Pressable
        onPress={handleSubmit}
        disabled={!canSubmit}
        className={cn(
          "w-9 h-9 rounded-full items-center justify-center mb-0.5",
          canSubmit ? "bg-primary" : "bg-muted"
        )}
        accessibilityLabel="Send message"
        accessibilityRole="button"
        accessibilityState={{ disabled: !canSubmit }}
      >
        <SymbolView
          name="arrow.up"
          size={18}
          weight="semibold"
          tintColor={canSubmit ? "#FFFFFF" : "#8E8E93"}
        />
      </Pressable>
    </View>
  );

  // Use GlassView on iOS 26+ for liquid glass effect
  if (isLiquidGlassAvailable()) {
    return (
      <Animated.View style={animatedStyle}>
        <GlassView isInteractive={false}>{inputContent}</GlassView>
      </Animated.View>
    );
  }

  // Fallback to semi-transparent background with blur
  return (
    <Animated.View
      style={[
        {
          backgroundColor: "rgba(249, 249, 249, 0.95)",
          borderTopWidth: 0.5,
          borderTopColor: "rgba(0, 0, 0, 0.1)",
        },
        animatedStyle,
      ]}
    >
      {inputContent}
    </Animated.View>
  );
}
