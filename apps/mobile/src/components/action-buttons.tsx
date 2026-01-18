/**
 * ActionButtons - Slack-style action buttons for card swipes
 *
 * Two main buttons (Skip / Send) plus a snooze option.
 * Matches Slack's "Keep Unread" / "Mark as Read" UI pattern.
 * Uses GlassView for iOS 26+ liquid glass effect.
 */

import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { SymbolView } from "expo-symbols";
import type { SFSymbol } from "sf-symbols-typescript";
import * as Haptics from "expo-haptics";
import { View, Text, Pressable } from "react-native";
import type { SwipeDirection } from "./swipeable-card";
import { cn } from "@/lib/utils";

// Colors matching the swipeable card backgrounds
const COLORS = {
  send: "#1B5E3D", // Dark green for send (right swipe)
  skip: "#6B7280", // Gray for skip (left swipe)
  snooze: "#B45309", // Amber for snooze (up swipe)
};

export interface ActionButtonsProps {
  onSwipe: (direction: SwipeDirection) => void;
  disabled?: boolean;
  /** Custom label for skip button (default: "Skip") */
  skipLabel?: string;
  /** Custom label for send button (default: "Send") */
  sendLabel?: string;
}

/** Primary action button (Skip or Send) */
function PrimaryButton({
  label,
  icon,
  variant,
  onPress,
  disabled,
}: {
  label: string;
  icon: SFSymbol;
  variant: "skip" | "send";
  onPress: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  const handlePress = (): void => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onPress();
  };

  const isSend = variant === "send";
  const color = isSend ? COLORS.send : COLORS.skip;

  const content = (
    <View
      className={cn("flex-row items-center justify-center gap-2 rounded-2xl flex-1", isSend ? "" : "border border-border")}
    >
      <SymbolView
        name={icon}
        size={16}
        tintColor={isSend ? "white" : color}
        weight="semibold"
      />
      <Text
        className="font-semibold text-foreground text-base"
      >
        {label}
      </Text>
    </View>
  );

  // Use GlassView on iOS 26+ for liquid glass effect
  if (isLiquidGlassAvailable()) {
    return (
      <Pressable
        onPress={handlePress}
        disabled={disabled}
        className="flex-1"
        style={{ opacity: disabled ? 0.5 : 1 }}
      >
        <GlassView
          isInteractive
          tintColor={isSend ? color : undefined}
          style={{
            borderRadius: 16,
            flex: 1,
          }}
        >
          <View
            className="flex-row flex-1 items-center justify-center gap-2"
          >
            <SymbolView
              name={icon}
              size={16}
              tintColor={isSend ? "white" : color}
              weight="semibold"
            />
            <Text
              className="font-semibold text-foreground text-base"
            >
              {label}
            </Text>
          </View>
        </GlassView>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      className="flex-1"
      style={{ opacity: disabled ? 0.5 : 1 }}
    >
      {content}
    </Pressable>
  );
}

/** Small snooze button */
function SnoozeButton({
  onPress,
  disabled,
}: {
  onPress: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  const handlePress = (): void => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress();
  };

  const content = (
    <View className="items-center justify-center p-3">
      <SymbolView
        name="clock"
        size={22}
        tintColor={COLORS.snooze}
        weight="semibold"
      />
    </View>
  );

  if (isLiquidGlassAvailable()) {
    return (
      <Pressable
        onPress={handlePress}
        disabled={disabled}
        style={{ opacity: disabled ? 0.5 : 1 }}
      >
        <GlassView isInteractive style={{ borderRadius: 12 }}>
          {content}
        </GlassView>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      className="bg-card rounded-xl border border-border"
      style={{ opacity: disabled ? 0.5 : 1 }}
    >
      {content}
    </Pressable>
  );
}

export function ActionButtons({
  onSwipe,
  disabled = false,
  skipLabel = "Skip",
  sendLabel = "Send",
}: ActionButtonsProps): React.JSX.Element {
  return (
    <View className="flex-row items-center gap-3 px-4 py-3">
      {/* Skip button - maps to left swipe */}
      <PrimaryButton
        label={skipLabel}
        icon="xmark"
        variant="skip"
        onPress={() => onSwipe("left")}
        disabled={disabled}
      />

      {/* Snooze button - maps to up swipe */}
      <SnoozeButton onPress={() => onSwipe("up")} disabled={disabled} />

      {/* Send button - maps to right swipe */}
      <PrimaryButton
        label={sendLabel}
        icon="checkmark"
        variant="send"
        onPress={() => onSwipe("right")}
        disabled={disabled}
      />
    </View>
  );
}
