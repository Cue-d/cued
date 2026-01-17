/**
 * AdaptiveGlass - Liquid Glass with graceful fallbacks
 *
 * Uses GlassView on iOS 26+ when transparency is enabled.
 * Falls back to BlurView on older iOS, solid View on Android.
 */

import { type ReactNode, useEffect, useState } from "react";
import { AccessibilityInfo, Platform, type ViewProps } from "react-native";
import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { View } from "./index";

export type AdaptiveGlassProps = {
  /**
   * Fallback background color for Android or when transparency is reduced.
   * @default "rgba(128, 128, 128, 0.5)"
   */
  fallbackColor?: string;
  /**
   * Whether the glass effect should be interactive.
   * @default false
   */
  isInteractive?: boolean;
  /**
   * Blur intensity for the BlurView fallback (1-100).
   * @default 50
   */
  blurIntensity?: number;
} & ViewProps;

export function AdaptiveGlass({
  fallbackColor = "rgba(128, 128, 128, 0.5)",
  isInteractive = false,
  blurIntensity = 50,
  style,
  children,
  ...rest
}: AdaptiveGlassProps): ReactNode {
  const [reduceTransparency, setReduceTransparency] = useState(false);

  useEffect(() => {
    // Check initial state
    AccessibilityInfo.isReduceTransparencyEnabled().then(setReduceTransparency);

    // Listen for changes
    const subscription = AccessibilityInfo.addEventListener(
      "reduceTransparencyChanged",
      setReduceTransparency,
    );

    return () => subscription.remove();
  }, []);

  // iOS 26+ with Liquid Glass available and transparency enabled
  if (
    Platform.OS === "ios" &&
    isLiquidGlassAvailable() &&
    !reduceTransparency
  ) {
    return (
      <GlassView style={style} isInteractive={isInteractive} {...rest}>
        {children}
      </GlassView>
    );
  }

  // Older iOS: Use BlurView
  if (Platform.OS === "ios" && !reduceTransparency) {
    return (
      <BlurView
        style={style}
        tint="systemMaterial"
        intensity={blurIntensity}
        {...rest}
      >
        {children}
      </BlurView>
    );
  }

  // Android or reduce transparency enabled: solid background
  return (
    <View style={[{ backgroundColor: fallbackColor }, style]} {...rest}>
      {children}
    </View>
  );
}
