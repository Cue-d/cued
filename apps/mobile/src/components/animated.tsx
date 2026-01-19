/**
 * Animated components using Reanimated
 *
 * Wraps React Native components with Animated.createAnimatedComponent()
 * to enable Reanimated animations.
 */

import { View } from "react-native";
import Animated from "react-native-reanimated";

// Create animated versions of React Native components
export const AnimatedView = Animated.createAnimatedComponent(View);
