/**
 * CSS-wrapped Animated components using Reanimated
 */

import Animated from "react-native-reanimated";
import { View, ScrollView } from "./index";

export const AnimatedView = Animated.createAnimatedComponent(View);
export const AnimatedScrollView = Animated.createAnimatedComponent(ScrollView);
