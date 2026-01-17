/**
 * CSS component wrappers using react-native-css
 *
 * These wrappers enable className support for React Native components
 * via NativeWind v5's CSS runtime.
 */

import {
  View as RNView,
  Text as RNText,
  ScrollView as RNScrollView,
  Pressable as RNPressable,
  TextInput as RNTextInput,
  type ViewProps,
  type TextProps,
  type ScrollViewProps,
  type PressableProps,
  type TextInputProps,
} from "react-native";
import {
  useCssElement,
  useNativeVariable,
  type StyledConfiguration,
  type StyledProps,
} from "react-native-css";

// Standard mapping for components that only need className -> style
const classNameMapping = { className: "style" } as const;

export function View(
  props: StyledProps<ViewProps, typeof classNameMapping>,
): ReturnType<typeof useCssElement> {
  return useCssElement(RNView, props, classNameMapping);
}

export function Text(
  props: StyledProps<TextProps, typeof classNameMapping>,
): ReturnType<typeof useCssElement> {
  return useCssElement(RNText, props, classNameMapping);
}

export function Pressable(
  props: StyledProps<PressableProps, typeof classNameMapping>,
): ReturnType<typeof useCssElement> {
  return useCssElement(RNPressable, props, classNameMapping);
}

export function TextInput(
  props: StyledProps<TextInputProps, typeof classNameMapping>,
): ReturnType<typeof useCssElement> {
  return useCssElement(RNTextInput, props, classNameMapping);
}

// ScrollView has additional contentContainerClassName support
const scrollViewMapping = {
  className: "style",
  contentContainerClassName: "contentContainerStyle",
} satisfies StyledConfiguration<typeof RNScrollView>;

export function ScrollView(
  props: StyledProps<ScrollViewProps, typeof scrollViewMapping>,
): ReturnType<typeof useCssElement> {
  return useCssElement(RNScrollView, props, scrollViewMapping);
}

export { useNativeVariable as useCSSVariable };
