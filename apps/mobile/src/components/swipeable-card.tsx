/**
 * SwipeableCard component with gesture-based swipe interactions
 *
 * Supports 3 swipe directions:
 * - Right: Send/Complete action (teal overlay)
 * - Left: Discard/Dismiss action (gray overlay)
 * - Up: Snooze action (amber overlay)
 */

import { type ReactNode, useRef, useEffect, useCallback } from "react";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  interpolate,
  runOnJS,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { View, Text } from "@/tw";

export type SwipeDirection = "left" | "right" | "up";

export interface SwipeableCardProps {
  children: ReactNode;
  onSwipe: (direction: SwipeDirection) => void;
  disabled?: boolean;
  className?: string;
  /** Set to trigger a programmatic swipe animation */
  triggerSwipe?: SwipeDirection | null;
}

// Thresholds for triggering swipe actions
const SWIPE_THRESHOLD_X = 120;
const SWIPE_THRESHOLD_Y = 80;

// Spring configuration for animations
const SPRING_CONFIG = {
  damping: 20,
  stiffness: 200,
  mass: 0.5,
};

export function SwipeableCard({
  children,
  onSwipe,
  disabled = false,
  className,
  triggerSwipe,
}: SwipeableCardProps): React.JSX.Element {
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const isAnimatingRef = useRef(false);

  const triggerHaptic = (): void => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const triggerSuccessHaptic = (): void => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const handleSwipe = useCallback(
    (direction: SwipeDirection): void => {
      triggerSuccessHaptic();
      onSwipe(direction);
    },
    [onSwipe],
  );

  // Handle programmatic swipe trigger
  useEffect(() => {
    if (!triggerSwipe || isAnimatingRef.current) return;

    isAnimatingRef.current = true;
    const peekDistance = SWIPE_THRESHOLD_X + 20;
    const peekDistanceY = SWIPE_THRESHOLD_Y + 20;

    // First animate to peek position
    if (triggerSwipe === "right") {
      translateX.value = withTiming(peekDistance, { duration: 150 });
    } else if (triggerSwipe === "left") {
      translateX.value = withTiming(-peekDistance, { duration: 150 });
    } else if (triggerSwipe === "up") {
      translateY.value = withTiming(-peekDistanceY, { duration: 150 });
    }

    // After peek, animate off screen and call onSwipe
    const peekTimeout = setTimeout(() => {
      if (triggerSwipe === "right") {
        translateX.value = withSpring(400, SPRING_CONFIG);
      } else if (triggerSwipe === "left") {
        translateX.value = withSpring(-400, SPRING_CONFIG);
      } else if (triggerSwipe === "up") {
        translateY.value = withSpring(-400, SPRING_CONFIG);
      }
      handleSwipe(triggerSwipe);
    }, 150);

    // Reset animating state after animation completes
    const resetTimeout = setTimeout(() => {
      isAnimatingRef.current = false;
    }, 400);

    return () => {
      clearTimeout(peekTimeout);
      clearTimeout(resetTimeout);
    };
  }, [triggerSwipe, handleSwipe, translateX, translateY]);

  const panGesture = Gesture.Pan()
    .enabled(!disabled && !isAnimatingRef.current)
    .onStart(() => {
      runOnJS(triggerHaptic)();
    })
    .onUpdate((event) => {
      translateX.value = event.translationX;
      translateY.value = event.translationY;
    })
    .onEnd((event) => {
      const { translationX, translationY } = event;

      // Check if swipe exceeds thresholds
      if (translationX > SWIPE_THRESHOLD_X) {
        // Swipe right - Send/Complete
        isAnimatingRef.current = true;
        translateX.value = withSpring(400, SPRING_CONFIG);
        runOnJS(handleSwipe)("right");
      } else if (translationX < -SWIPE_THRESHOLD_X) {
        // Swipe left - Discard
        isAnimatingRef.current = true;
        translateX.value = withSpring(-400, SPRING_CONFIG);
        runOnJS(handleSwipe)("left");
      } else if (translationY < -SWIPE_THRESHOLD_Y) {
        // Swipe up - Snooze
        isAnimatingRef.current = true;
        translateY.value = withSpring(-400, SPRING_CONFIG);
        runOnJS(handleSwipe)("up");
      } else {
        // Return to center
        translateX.value = withSpring(0, SPRING_CONFIG);
        translateY.value = withSpring(0, SPRING_CONFIG);
      }
    });

  // Animated style for card transforms
  const cardAnimatedStyle = useAnimatedStyle(() => {
    // Rotation based on horizontal drag
    const rotate = interpolate(
      translateX.value,
      [-200, 0, 200],
      [-15, 0, 15],
    );

    // Scale based on horizontal drag distance
    const scale = interpolate(
      Math.abs(translateX.value),
      [0, 200],
      [1, 0.95],
    );

    // Opacity based on horizontal drag distance
    const opacity = interpolate(
      Math.abs(translateX.value),
      [0, 200],
      [1, 0.5],
    );

    return {
      transform: [
        { translateX: translateX.value },
        { translateY: translateY.value },
        { rotate: `${rotate}deg` },
        { scale },
      ],
      opacity,
    };
  });

  // Overlay opacity animations
  const rightOverlayStyle = useAnimatedStyle(() => {
    const opacity = interpolate(
      translateX.value,
      [0, SWIPE_THRESHOLD_X],
      [0, 0.95],
      "clamp",
    );
    return { opacity };
  });

  const leftOverlayStyle = useAnimatedStyle(() => {
    const opacity = interpolate(
      translateX.value,
      [-SWIPE_THRESHOLD_X, 0],
      [0.9, 0],
      "clamp",
    );
    return { opacity };
  });

  const upOverlayStyle = useAnimatedStyle(() => {
    const opacity = interpolate(
      translateY.value,
      [-SWIPE_THRESHOLD_Y, 0],
      [0.9, 0],
      "clamp",
    );
    return { opacity };
  });

  return (
    <GestureDetector gesture={panGesture}>
      <Animated.View
        className={className}
        style={cardAnimatedStyle}
      >
        {/* Right overlay - Send (teal) */}
        <Animated.View
          className="absolute inset-0 bg-[#00806B] rounded-2xl items-center justify-center z-10"
          style={rightOverlayStyle}
          pointerEvents="none"
        >
          <View className="items-center">
            <Text className="text-white text-4xl mb-2">✓</Text>
            <Text className="text-white text-lg font-semibold">Send</Text>
          </View>
        </Animated.View>

        {/* Left overlay - Discard (gray) */}
        <Animated.View
          className="absolute inset-0 bg-neutral-600 rounded-2xl items-center justify-center z-10"
          style={leftOverlayStyle}
          pointerEvents="none"
        >
          <View className="items-center">
            <Text className="text-white text-4xl mb-2">✕</Text>
            <Text className="text-white text-lg font-semibold">Discard</Text>
          </View>
        </Animated.View>

        {/* Up overlay - Snooze (amber) */}
        <Animated.View
          className="absolute inset-0 bg-amber-700 rounded-2xl items-center justify-center z-10"
          style={upOverlayStyle}
          pointerEvents="none"
        >
          <View className="items-center">
            <Text className="text-white text-4xl mb-2">⏰</Text>
            <Text className="text-white text-lg font-semibold">Snooze</Text>
          </View>
        </Animated.View>

        {/* Card content */}
        <View className="relative z-0">
          {children}
        </View>
      </Animated.View>
    </GestureDetector>
  );
}
