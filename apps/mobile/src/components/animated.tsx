/**
 * Animated components using Reanimated
 *
 * Wraps React Native components with Animated.createAnimatedComponent()
 * to enable Reanimated animations.
 */

import Animated from "react-native-reanimated";
import { View, Text, ScrollView, Pressable } from "react-native";

// Create animated versions of React Native components
export const AnimatedView = Animated.createAnimatedComponent(View);
export const AnimatedText = Animated.createAnimatedComponent(Text);
export const AnimatedScrollView = Animated.createAnimatedComponent(ScrollView);
export const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
