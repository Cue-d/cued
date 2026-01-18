/**
 * SkeletonCard component for loading states.
 *
 * Task 7.7: Animated skeleton card that matches card stack layout.
 * Shows shimmer animation using Reanimated.
 */

import { useEffect } from "react";
import { useWindowDimensions } from "react-native";
import {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
} from "react-native-reanimated";
import { View } from "react-native";
import { AnimatedView } from "@/components/animated";

// Animation constants
const ANIMATION_DURATION = 1000; // 1 second pulse cycle

interface SkeletonCardProps {
  /** Additional className for container */
  className?: string;
}

/**
 * Single skeleton card with animated shimmer
 */
export function SkeletonCard({ className }: SkeletonCardProps): React.JSX.Element {
  const opacity = useSharedValue(0.4);

  useEffect(() => {
    // Continuous pulse animation
    opacity.value = withRepeat(
      withTiming(0.8, {
        duration: ANIMATION_DURATION,
        easing: Easing.inOut(Easing.ease),
      }),
      -1, // Infinite repeat
      true, // Reverse on each cycle
    );
  }, [opacity]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <AnimatedView
      className={`w-full h-full bg-card rounded-2xl overflow-hidden ${className ?? ""}`}
      style={animatedStyle}
    >
      {/* Header skeleton */}
      <View className="p-4 flex-row items-center gap-3">
        {/* Avatar placeholder */}
        <View className="w-12 h-12 rounded-full bg-muted" />
        {/* Name and timestamp */}
        <View className="flex-1 gap-2">
          <View className="w-32 h-4 rounded bg-muted" />
          <View className="w-20 h-3 rounded bg-muted" />
        </View>
        {/* Platform badge placeholder */}
        <View className="w-16 h-6 rounded-full bg-muted" />
      </View>

      {/* Content skeleton - message bubbles */}
      <View className="px-4 flex-1 gap-3">
        {/* Received message */}
        <View className="self-start w-3/4 h-16 rounded-2xl bg-muted" />
        {/* Sent message */}
        <View className="self-end w-2/3 h-12 rounded-2xl bg-muted" />
        {/* Received message */}
        <View className="self-start w-4/5 h-20 rounded-2xl bg-muted" />
      </View>

      {/* Response input skeleton */}
      <View className="p-4">
        <View className="w-full h-20 rounded-xl bg-muted" />
      </View>
    </AnimatedView>
  );
}

// Stacking constants (match CardStack)
const VISIBLE_CARDS = 3;
const SCALE_OFFSET = 0.04;
const Y_OFFSET = 8;

/**
 * SkeletonStack shows 3 stacked skeleton cards matching CardStack layout
 */
export function SkeletonStack(): React.JSX.Element {
  const { width: screenWidth } = useWindowDimensions();
  
  // Calculate card dimensions (3:4 aspect ratio, with padding)
  const cardWidth = Math.min(screenWidth - 32, 400);
  const cardHeight = (cardWidth * 4) / 3;

  return (
    <View className="flex-1 items-center justify-center px-4">
      {/* Header skeleton */}
      <View className="absolute top-4 left-4 z-50">
        <View className="w-16 h-5 rounded bg-muted" />
      </View>

      {/* Skeleton card stack */}
      <View 
        className="relative"
        style={{ width: cardWidth, height: cardHeight }}
      >
        {Array.from({ length: VISIBLE_CARDS }).map((_, index) => {
          const scale = 1 - index * SCALE_OFFSET;
          const translateY = index * Y_OFFSET;
          const zIndex = VISIBLE_CARDS - index;

          return (
            <View
              key={index}
              className="absolute inset-0 shadow-lg"
              style={{
                zIndex,
                transform: [{ scale }, { translateY }],
              }}
            >
              <SkeletonCard />
            </View>
          );
        })}
      </View>
    </View>
  );
}
