/**
 * ChatInput - Text input component for agent chat with keyboard handling
 *
 * Features:
 * - Liquid glass container with unified pill shape
 * - Animated color transition (muted to primary) when text is entered
 * - Keyboard-responsive animated positioning
 * - Haptic feedback on send
 */

import { useEffect } from "react";
import { View, TextInput, Pressable, Platform, useColorScheme } from "react-native";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedKeyboard,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { getThemeColors } from "@/lib/utils";

const AnimatedSymbolView = Animated.createAnimatedComponent(SymbolView);

const CONTAINER_HEIGHT = 44;
const CONTAINER_RADIUS = 22;

export interface ChatInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  disabled?: boolean;
  /** Disable keyboard-responsive positioning (for use in cards) */
  disableKeyboardHandling?: boolean;
  /** Hide the outer padding wrapper */
  noPadding?: boolean;
  /** Use subtle inner style when already inside a GlassView */
  insideGlassContainer?: boolean;
}

function getContainerStyle(isDark: boolean, variant: "glass" | "fallback" | "inner") {
  const baseStyle = {
    height: CONTAINER_HEIGHT,
    borderRadius: CONTAINER_RADIUS,
    overflow: "hidden" as const,
  };

  if (variant === "glass") {
    return baseStyle;
  }

  if (variant === "inner") {
    return {
      ...baseStyle,
      backgroundColor: isDark ? "rgba(255, 255, 255, 0.06)" : "rgba(0, 0, 0, 0.04)",
      borderWidth: 1,
      borderColor: isDark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.06)",
    };
  }

  // fallback
  return {
    ...baseStyle,
    backgroundColor: isDark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.06)",
    borderWidth: 1,
    borderColor: isDark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.08)",
  };
}

export function ChatInput({
  value,
  onChangeText,
  onSubmit,
  placeholder = "Ask anything...",
  disabled = false,
  disableKeyboardHandling = false,
  noPadding = false,
  insideGlassContainer = false,
}: ChatInputProps): React.JSX.Element {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = getThemeColors(isDark);
  const keyboard = useAnimatedKeyboard({});
  const hasLiquidGlass = isLiquidGlassAvailable();

  const canSubmit = value.trim().length > 0 && !disabled;
  const colorProgress = useSharedValue(canSubmit ? 1 : 0);

  useEffect(() => {
    colorProgress.value = withTiming(canSubmit ? 1 : 0, {
      duration: 200,
      easing: Easing.out(Easing.ease),
    });
  }, [canSubmit, colorProgress]);

  const animatedIconProps = useAnimatedProps(() => ({
    tintColor: interpolateColor(
      colorProgress.value,
      [0, 1],
      [colors.mutedForeground, colors.primary]
    ),
  }));

  const animatedStyle = useAnimatedStyle(() => {
    const keyboardOpen = keyboard.height.value > 0;
    const baseMargin = hasLiquidGlass ? 80 : 0;
    return {
      paddingBottom: keyboardOpen ? keyboard.height.value : 8,
      marginBottom: keyboardOpen ? 0 : baseMargin,
    };
  }, [hasLiquidGlass]);

  function handleSubmit(): void {
    if (!canSubmit || !onSubmit) return;
    if (Platform.OS === "ios") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    onSubmit();
  }

  const inputContent = (
    <View className="flex-row items-center flex-1 gap-3 px-4 h-11">
      <TextInput
        className="flex-1 h-11 text-foreground text-base pt-2"
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        returnKeyType="send"
        editable={!disabled}
        onSubmitEditing={handleSubmit}
        accessibilityLabel="Message input"
        accessibilityHint="Type your message here"
        placeholderTextColorClassName="text-muted-foreground"
        multiline
      />

      <Pressable
        onPress={canSubmit ? handleSubmit : undefined}
        hitSlop={8}
        accessibilityLabel="Send message"
        accessibilityRole="button"
        accessibilityState={{ disabled: !canSubmit }}
      >
        <AnimatedSymbolView
          name="arrow.up.circle.fill"
          size={28}
          weight="medium"
          animatedProps={animatedIconProps}
        />
      </Pressable>
    </View>
  );

  function renderGlassContainer(): React.JSX.Element {
    if (insideGlassContainer) {
      return <View style={getContainerStyle(isDark, "inner")}>{inputContent}</View>;
    }
    if (hasLiquidGlass) {
      return <GlassView style={getContainerStyle(isDark, "glass")}>{inputContent}</GlassView>;
    }
    return <View style={getContainerStyle(isDark, "fallback")}>{inputContent}</View>;
  }

  if (disableKeyboardHandling) {
    if (noPadding) {
      return renderGlassContainer();
    }
    return <View className="px-4 py-3">{renderGlassContainer()}</View>;
  }

  return (
    <Animated.View style={animatedStyle}>
      <View className="px-4 py-3">{renderGlassContainer()}</View>
    </Animated.View>
  );
}
