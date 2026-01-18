/**
 * ChatInput - Text input component for agent chat with keyboard handling
 *
 * Features:
 * - Liquid glass text field container
 * - Multiline text input with rounded styling
 * - Send button with SF Symbol
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

import { View, TextInput, Pressable, Platform, useColorScheme } from "react-native";
import { cn, getThemeColors } from "@/lib/utils";

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
  placeholder = "Ask anything...",
  disabled = false,
}: ChatInputProps) {
  const canSubmit = value.trim().length > 0 && !disabled;
  const keyboard = useAnimatedKeyboard({});
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = getThemeColors(isDark);

  const handleSubmit = () => {
    if (!canSubmit) return;
    if (Platform.OS === "ios") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    onSubmit();
  };

  // Animate based on keyboard height
  // When Liquid Glass tabs are available, add extra bottom margin to sit above the floating tab bar
  const hasLiquidGlass = isLiquidGlassAvailable();
  const animatedStyle = useAnimatedStyle(() => {
    const keyboardOpen = keyboard.height.value > 0;
    return {
      paddingBottom: keyboardOpen ? keyboard.height.value : 8,
      // Add margin to position above floating Liquid Glass tab bar
      marginBottom: keyboardOpen ? 0 : hasLiquidGlass ? 80 : 0,
    };
  }, [hasLiquidGlass]);

  const inputField = (
    <View
      className="flex-1 flex-row items-end rounded-full px-4 py-2"
      style={{
        backgroundColor: isDark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.04)",
        minHeight: 40,
      }}
    >
      <TextInput
        className="flex-1 text-foreground text-[16px] min-h-[24px] max-h-[120px]"
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColorClassName="accent-muted-foreground"
        multiline
        returnKeyType="send"
        blurOnSubmit={false}
        editable={!disabled}
        onSubmitEditing={handleSubmit}
        accessibilityLabel="Message input"
        accessibilityHint="Type your message here"
      />
    </View>
  );

  const sendButton = (
    <Pressable
      onPress={handleSubmit}
      disabled={!canSubmit}
      className={cn(
        "w-10 h-10 rounded-full items-center justify-center",
        canSubmit ? "bg-primary" : ""
      )}
      style={!canSubmit ? {
        backgroundColor: isDark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.04)",
      } : undefined}
      accessibilityLabel="Send message"
      accessibilityRole="button"
      accessibilityState={{ disabled: !canSubmit }}
    >
      <SymbolView
        name="arrow.up"
        size={18}
        weight="semibold"
        tintColor={canSubmit ? colors.white : colors.mutedForeground}
      />
    </Pressable>
  );

  const inputContent = (
    <View className="flex-row items-end gap-2 px-4 py-3">
      {inputField}
      {sendButton}
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

  // Fallback with subtle background and border
  return (
    <Animated.View
      style={[
        {
          backgroundColor: isDark ? "rgba(0, 0, 0, 0.8)" : "rgba(255, 255, 255, 0.95)",
          borderTopWidth: 0.5,
          borderTopColor: isDark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.08)",
        },
        animatedStyle,
      ]}
    >
      {inputContent}
    </Animated.View>
  );
}
