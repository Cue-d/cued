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
import { isLiquidGlassAvailable } from "expo-glass-effect";
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
  // When Liquid Glass tabs are available, add extra bottom margin above the floating tab bar
  const hasLiquidGlass = isLiquidGlassAvailable();
  const animatedStyle = useAnimatedStyle(() => {
    const keyboardOpen = keyboard.height.value > 0;
    const baseMargin = hasLiquidGlass ? 80 : 0;
    return {
      paddingBottom: keyboardOpen ? keyboard.height.value : 8,
      marginBottom: keyboardOpen ? 0 : baseMargin,
    };
  }, [hasLiquidGlass]);

  const inputField = (
    <View
      className="flex-1 flex-row items-end px-4 py-2"
      style={{
        minHeight: 40,
        borderRadius: 20,
        backgroundColor: isDark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.06)",
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

  const disabledButtonBackground = isDark
    ? "rgba(255, 255, 255, 0.08)"
    : "rgba(0, 0, 0, 0.04)";

  const sendButton = (
    <Pressable
      onPress={handleSubmit}
      disabled={!canSubmit}
      className={cn(
        "w-10 h-10 rounded-full items-center justify-center",
        canSubmit && "bg-primary"
      )}
      style={!canSubmit ? { backgroundColor: disabledButtonBackground } : undefined}
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

  return (
    <Animated.View style={animatedStyle}>
      <View className="flex-row items-end gap-2 px-4 py-3">
        {inputField}
        {sendButton}
      </View>
    </Animated.View>
  );
}
