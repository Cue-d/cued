/**
 * SwipeableCard component with Slack-style swipe interactions
 *
 * Features:
 * - Liquid glass card styling (iOS 26+)
 * - Circular progress indicator showing swipe completion
 * - Background color overlay that changes based on swipe direction
 * - Three swipe directions: right (send), left (skip), up (snooze)
 */

import { type ReactNode, useRef, useEffect, useCallback } from "react";
import { View } from "react-native";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  interpolate,
  runOnJS,
  type SharedValue,
} from "react-native-reanimated";
import { AnimatedView } from "@/components/animated";

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
const SWIPE_THRESHOLD_X = 100;
const SWIPE_THRESHOLD_Y = 80;

// Spring configuration for smooth animations
const SPRING_CONFIG = {
  damping: 20,
  stiffness: 180,
  mass: 0.8,
};

// Smoother spring for return to center
const RETURN_SPRING_CONFIG = {
  damping: 22,
  stiffness: 200,
  mass: 0.6,
};

// Action colors
const COLORS = {
  send: "#1B5E3D", // Dark green for send (right swipe)
  skip: "#6B7280", // Gray for skip (left swipe)
  snooze: "#B45309", // Amber for snooze (up swipe)
  default: "rgba(255,255,255,0.5)",
  defaultBg: "rgba(0,0,0,0.5)",
};

type Direction = "left" | "right" | "up" | "none";

/** Get the color for a given swipe direction */
function getDirectionColor(dir: Direction, defaultColor: string): string {
  "worklet";
  switch (dir) {
    case "right":
      return COLORS.send;
    case "left":
      return COLORS.skip;
    case "up":
      return COLORS.snooze;
    default:
      return defaultColor;
  }
}

// Circular progress indicator size and stroke
const PROGRESS_SIZE = 64;
const STROKE_WIDTH = 6;

/** Radial progress ring component - clockwise from top center */
function RadialProgress({
  progress,
  direction,
}: {
  progress: SharedValue<number>;
  direction: SharedValue<Direction>;
}): React.JSX.Element {
  const size = PROGRESS_SIZE;
  const halfSize = size / 2;

  // Right arc (0-50% progress) - rotates clockwise from -180° to 0°
  const rightArcStyle = useAnimatedStyle(() => {
    "worklet";
    const rotation = interpolate(progress.value, [0, 0.5], [-180, 0], "clamp");
    return {
      transform: [{ rotate: `${rotation}deg` }],
      borderColor: getDirectionColor(direction.value, COLORS.default),
    };
  });

  // Left arc (50-100% progress) - rotates clockwise from 180° to 360°
  const leftArcStyle = useAnimatedStyle(() => {
    "worklet";
    const rotation = interpolate(progress.value, [0.5, 1], [180, 360], "clamp");
    return {
      transform: [{ rotate: `${rotation}deg` }],
      borderColor: getDirectionColor(direction.value, COLORS.default),
    };
  });

  // Hide left container until 50% progress
  const leftContainerStyle = useAnimatedStyle(() => {
    "worklet";
    return { opacity: progress.value > 0.5 ? 1 : 0 };
  });

  // Right semicircle arc shape (right half of a ring)
  const rightArcShape = {
    width: halfSize,
    height: size,
    borderWidth: STROKE_WIDTH,
    borderLeftWidth: 0,
    borderTopRightRadius: halfSize,
    borderBottomRightRadius: halfSize,
  };

  // Left semicircle arc shape (left half of a ring)
  const leftArcShape = {
    width: halfSize,
    height: size,
    borderWidth: STROKE_WIDTH,
    borderRightWidth: 0,
    borderTopLeftRadius: halfSize,
    borderBottomLeftRadius: halfSize,
  };

  return (
    <View
      style={{
        width: size,
        height: size,
        position: "absolute",
      }}
    >
      {/* Background track */}
      <View
        style={{
          position: "absolute",
          width: size,
          height: size,
          borderRadius: halfSize,
          borderWidth: STROKE_WIDTH,
          borderColor: "rgba(255,255,255,0.2)",
        }}
      />

      {/* Right half container (0-50%) - clips to right side */}
      <View
        style={{
          position: "absolute",
          width: halfSize,
          height: size,
          left: halfSize,
          overflow: "hidden",
        }}
      >
        <AnimatedView
          style={[
            rightArcShape,
            rightArcStyle,
            {
              position: "absolute",
              left: 0,
              transformOrigin: `${STROKE_WIDTH / 2}px ${halfSize}px`,
            },
          ]}
        />
      </View>

      {/* Left half container (50-100%) - clips to left side */}
      <AnimatedView
        style={[
          leftContainerStyle,
          {
            position: "absolute",
            width: halfSize,
            height: size,
            left: 0,
            overflow: "hidden",
          },
        ]}
      >
        <AnimatedView
          style={[
            leftArcShape,
            leftArcStyle,
            {
              position: "absolute",
              right: 0,
              transformOrigin: `${halfSize - STROKE_WIDTH / 2}px ${halfSize}px`,
            },
          ]}
        />
      </AnimatedView>
    </View>
  );
}

/** Progress indicator with icon that shows during swipe */
function SwipeProgressOverlay({
  progress,
  direction,
}: {
  progress: SharedValue<number>;
  direction: SharedValue<Direction>;
}): React.JSX.Element {
  const containerStyle = useAnimatedStyle(() => {
    const opacity = interpolate(progress.value, [0, 0.15, 0.3], [0, 0, 1], "clamp");
    return { opacity };
  });

  // Use flexbox alignment for positioning based on direction
  const alignmentStyle = useAnimatedStyle(() => {
    "worklet";
    switch (direction.value) {
      case "right":
        return { justifyContent: "flex-start", alignItems: "flex-start" };
      case "left":
        return { justifyContent: "flex-start", alignItems: "flex-end" };
      case "up":
        return { justifyContent: "flex-end", alignItems: "center" };
      default:
        return { justifyContent: "flex-start", alignItems: "flex-start" };
    }
  });

  const circleStyle = useAnimatedStyle(() => {
    "worklet";
    const scale = interpolate(progress.value, [0, 0.3, 0.6, 1], [0.5, 0.7, 0.9, 1], "clamp");
    return {
      backgroundColor: getDirectionColor(direction.value, COLORS.defaultBg),
      transform: [{ scale }],
    };
  });

  const iconContainerStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.3, 0.6], [0, 1], "clamp"),
  }));

  return (
    <AnimatedView
      style={[containerStyle, alignmentStyle]}
      className="absolute inset-0 z-30 p-5"
      pointerEvents="none"
    >
      <AnimatedView
        style={circleStyle}
        className="w-16 h-16 rounded-full items-center justify-center"
      >
        {/* Radial progress ring */}
        <RadialProgress progress={progress} direction={direction} />
        {/* Icon */}
        <AnimatedView style={iconContainerStyle}>
          <DirectionIcon direction={direction} />
        </AnimatedView>
      </AnimatedView>
    </AnimatedView>
  );
}

const DIRECTION_ICONS: readonly { dir: SwipeDirection; name: "checkmark" | "xmark" | "clock" }[] = [
    { dir: "right", name: "checkmark" },
    { dir: "left", name: "xmark" },
    { dir: "up", name: "clock" },
  ];

/** Icon component that changes based on swipe direction */
function DirectionIcon({
  direction,
}: {
  direction: SharedValue<Direction>;
}): React.JSX.Element {
  return (
    <View className="w-6 h-6 items-center justify-center">
      {DIRECTION_ICONS.map(({ dir, name }) => (
        <DirectionIconItem key={dir} direction={direction} targetDir={dir} iconName={name} />
      ))}
    </View>
  );
}

function DirectionIconItem({
  direction,
  targetDir,
  iconName,
}: {
  direction: SharedValue<Direction>;
  targetDir: Direction;
  iconName: "checkmark" | "xmark" | "clock";
}): React.JSX.Element {
  const style = useAnimatedStyle(() => ({
    opacity: direction.value === targetDir ? 1 : 0,
    position: "absolute" as const,
  }));

  return (
    <AnimatedView style={style}>
      <SymbolView name={iconName} size={22} tintColor="white" weight="bold" />
    </AnimatedView>
  );
}

export function SwipeableCard({
  children,
  onSwipe,
  disabled = false,
  className,
  triggerSwipe,
}: SwipeableCardProps): React.JSX.Element {
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const progress = useSharedValue(0);
  const direction = useSharedValue<Direction>("none");
  const isAnimatingRef = useRef(false);

  const triggerHaptic = (): void => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const triggerSuccessHaptic = (): void => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const handleSwipe = useCallback(
    (swipeDirection: SwipeDirection): void => {
      triggerSuccessHaptic();
      onSwipe(swipeDirection);
    },
    [onSwipe],
  );

  // Reset card to center position
  const resetToCenter = useCallback((): void => {
    translateX.value = withSpring(0, RETURN_SPRING_CONFIG);
    translateY.value = withSpring(0, RETURN_SPRING_CONFIG);
    progress.value = withSpring(0, RETURN_SPRING_CONFIG);
    direction.value = "none";
  }, [translateX, translateY, progress, direction]);

  // Handle programmatic swipe trigger
  useEffect(() => {
    if (!triggerSwipe || isAnimatingRef.current) return;

    isAnimatingRef.current = true;
    direction.value = triggerSwipe;

    const peekSpring = { damping: 18, stiffness: 250, mass: 0.5 };
    const peekX = SWIPE_THRESHOLD_X + 20;
    const peekY = SWIPE_THRESHOLD_Y + 20;

    // Animate to peek position
    switch (triggerSwipe) {
      case "right":
        translateX.value = withSpring(peekX, peekSpring);
        break;
      case "left":
        translateX.value = withSpring(-peekX, peekSpring);
        break;
      case "up":
        translateY.value = withSpring(-peekY, peekSpring);
        break;
    }
    progress.value = withSpring(1, peekSpring);

    // After peek, animate off screen (or reset for snooze)
    const peekTimeout = setTimeout(() => {
      switch (triggerSwipe) {
        case "right":
          translateX.value = withSpring(500, SPRING_CONFIG);
          break;
        case "left":
          translateX.value = withSpring(-500, SPRING_CONFIG);
          break;
        case "up":
          resetToCenter();
          break;
      }
      handleSwipe(triggerSwipe);
    }, 180);

    const resetTimeout = setTimeout(() => {
      isAnimatingRef.current = false;
    }, 450);

    return () => {
      clearTimeout(peekTimeout);
      clearTimeout(resetTimeout);
    };
  }, [triggerSwipe, handleSwipe, translateX, translateY, progress, direction, resetToCenter]);

  const panGesture = Gesture.Pan()
    .enabled(!disabled && !isAnimatingRef.current)
    .onStart(() => {
      runOnJS(triggerHaptic)();
    })
    .onUpdate((event) => {
      translateX.value = event.translationX;
      translateY.value = event.translationY;

      const absX = Math.abs(event.translationX);
      const absY = Math.abs(event.translationY);

      // Horizontal swipe takes priority
      if (absX > absY && absX > 10) {
        direction.value = event.translationX > 0 ? "right" : "left";
        progress.value = Math.min(absX / SWIPE_THRESHOLD_X, 1);
      } else if (absY > absX && event.translationY < -10) {
        direction.value = "up";
        progress.value = Math.min(absY / SWIPE_THRESHOLD_Y, 1);
      } else {
        direction.value = "none";
        progress.value = 0;
      }
    })
    .onEnd((event) => {
      const { translationX, translationY } = event;

      if (translationX > SWIPE_THRESHOLD_X) {
        isAnimatingRef.current = true;
        translateX.value = withSpring(500, SPRING_CONFIG);
        runOnJS(handleSwipe)("right");
      } else if (translationX < -SWIPE_THRESHOLD_X) {
        isAnimatingRef.current = true;
        translateX.value = withSpring(-500, SPRING_CONFIG);
        runOnJS(handleSwipe)("left");
      } else if (translationY < -SWIPE_THRESHOLD_Y) {
        runOnJS(resetToCenter)();
        runOnJS(handleSwipe)("up");
      } else {
        runOnJS(resetToCenter)();
      }
    });

  // Animated style for card transforms
  const cardAnimatedStyle = useAnimatedStyle(() => {
    // Rotation based on horizontal drag (subtle tilt)
    const rotate = interpolate(translateX.value, [-250, 0, 250], [-8, 0, 8]);

    // Subtle scale down as card moves
    const absX = Math.abs(translateX.value);
    const absY = Math.abs(translateY.value);
    const maxDist = Math.max(absX, absY);
    const scale = interpolate(maxDist, [0, 150], [1, 0.95], "clamp");

    return {
      transform: [
        { translateX: translateX.value },
        { translateY: translateY.value },
        { rotate: `${rotate}deg` },
        { scale },
      ],
    };
  });

  // Background color overlay
  const overlayStyle = useAnimatedStyle(() => {
    "worklet";
    return {
      backgroundColor: getDirectionColor(direction.value, "transparent"),
      opacity: interpolate(progress.value, [0, 0.3, 1], [0, 0.08, 0.2], "clamp"),
    };
  });

  // Card content with glass effect
  const CardContent = (
    <View className="flex-1 relative overflow-hidden">
      {/* Background color overlay */}
      <AnimatedView
        style={overlayStyle}
        className="absolute inset-0 z-10"
        pointerEvents="none"
      />

      {/* Progress indicator */}
      <SwipeProgressOverlay progress={progress} direction={direction} />

      {/* Card content */}
      <View className="flex-1 z-0">{children}</View>
    </View>
  );

  // Use GlassView on iOS 26+
  const GlassCard = isLiquidGlassAvailable() ? (
    <GlassView
      style={{
        flex: 1,
        borderRadius: 24,
        overflow: "hidden",
      }}
    >
      {CardContent}
    </GlassView>
  ) : (
    <View
      className="flex-1 bg-card rounded-3xl overflow-hidden"
      style={{
        borderWidth: 1,
        borderColor: "rgba(0, 0, 0, 0.08)",
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.12,
        shadowRadius: 16,
        elevation: 8,
      }}
    >
      {CardContent}
    </View>
  );

  return (
    <GestureDetector gesture={panGesture}>
      <AnimatedView className={className} style={cardAnimatedStyle}>
        {GlassCard}
      </AnimatedView>
    </GestureDetector>
  );
}
