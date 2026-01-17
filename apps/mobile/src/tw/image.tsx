/**
 * CSS-wrapped Image component using expo-image
 *
 * react-native-css automatically maps:
 * - object-fit CSS property → contentFit prop
 * - object-position CSS property → contentPosition prop
 */

import { Image as ExpoImage, type ImageProps as ExpoImageProps } from "expo-image";
import Animated from "react-native-reanimated";
import { useCssElement, type StyledProps } from "react-native-css";

const classNameMapping = { className: "style" } as const;

// Create animated version of expo-image for use with reanimated
export const AnimatedExpoImage = Animated.createAnimatedComponent(ExpoImage);

/**
 * CSS-wrapped Image component
 *
 * Supports className with Tailwind utilities including:
 * - object-cover, object-contain, etc. (maps to contentFit)
 * - object-center, object-top, etc. (maps to contentPosition)
 */
export function Image(
  props: StyledProps<ExpoImageProps, typeof classNameMapping>,
): ReturnType<typeof useCssElement> {
  return useCssElement(ExpoImage, props, classNameMapping);
}
