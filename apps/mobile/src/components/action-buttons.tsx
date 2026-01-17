/**
 * ActionButtons - Glass-styled buttons for triggering card swipes
 *
 * Provides accessible button alternatives to swipe gestures.
 * Uses GlassView for iOS 26+ liquid glass effect.
 */

import { Pressable } from "react-native";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { SymbolView } from "expo-symbols";
import type { SFSymbol } from "sf-symbols-typescript";
import * as Haptics from "expo-haptics";
import { View, Text } from "@/tw";
import type { SwipeDirection } from "./swipeable-card";

export interface ActionButtonsProps {
  onSwipe: (direction: SwipeDirection) => void;
  disabled?: boolean;
}

interface ButtonConfig {
  direction: SwipeDirection;
  icon: SFSymbol;
  label: string;
  color: string;
}

const BUTTONS: ButtonConfig[] = [
  { direction: "left", icon: "xmark", label: "Discard", color: "#8E8E93" },
  { direction: "up", icon: "clock", label: "Snooze", color: "#FF9500" },
  { direction: "right", icon: "checkmark", label: "Send", color: "#00806B" },
];

function ActionButton({
  config,
  onPress,
  disabled,
}: {
  config: ButtonConfig;
  onPress: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  const handlePress = (): void => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onPress();
  };

  const content = (
    <View className="items-center justify-center p-4">
      <SymbolView
        name={config.icon}
        size={28}
        tintColor={config.color}
        weight="semibold"
      />
      <Text
        className="text-xs mt-1 font-medium"
        style={{ color: config.color }}
      >
        {config.label}
      </Text>
    </View>
  );

  // Use GlassView on iOS 26+ for liquid glass effect
  if (isLiquidGlassAvailable()) {
    return (
      <Pressable onPress={handlePress} disabled={disabled}>
        <GlassView
          isInteractive
          style={{
            borderRadius: 16,
            minWidth: 80,
            opacity: disabled ? 0.5 : 1,
          }}
        >
          {content}
        </GlassView>
      </Pressable>
    );
  }

  // Fallback for older iOS and Android
  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      className="bg-sf-secondaryBg rounded-2xl min-w-[80px]"
      style={{ opacity: disabled ? 0.5 : 1 }}
    >
      {content}
    </Pressable>
  );
}

export function ActionButtons({
  onSwipe,
  disabled = false,
}: ActionButtonsProps): React.JSX.Element {
  return (
    <View className="flex-row justify-center items-center gap-4 py-4">
      {BUTTONS.map((config) => (
        <ActionButton
          key={config.direction}
          config={config}
          onPress={() => onSwipe(config.direction)}
          disabled={disabled}
        />
      ))}
    </View>
  );
}
