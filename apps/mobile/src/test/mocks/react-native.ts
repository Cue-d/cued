/**
 * React Native mock for Vitest testing
 * Provides minimal implementations of commonly used RN components and APIs
 */
import React from "react";

// Basic component mock factory
const createMockComponent = (name: string) => {
  const Component = ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => {
    return React.createElement(name, props, children);
  };
  Component.displayName = name;
  return Component;
};

// Core components
export const View = createMockComponent("View");
export const Text = createMockComponent("Text");
export const TextInput = createMockComponent("TextInput");
export const TouchableOpacity = createMockComponent("TouchableOpacity");
export const TouchableHighlight = createMockComponent("TouchableHighlight");
export const TouchableWithoutFeedback = createMockComponent("TouchableWithoutFeedback");
export const Pressable = createMockComponent("Pressable");
export const ScrollView = createMockComponent("ScrollView");
export const FlatList = createMockComponent("FlatList");
export const SectionList = createMockComponent("SectionList");
export const Image = createMockComponent("Image");
export const ActivityIndicator = createMockComponent("ActivityIndicator");
export const Modal = createMockComponent("Modal");
export const SafeAreaView = createMockComponent("SafeAreaView");
export const KeyboardAvoidingView = createMockComponent("KeyboardAvoidingView");

// Platform API
export const Platform = {
  OS: "ios" as const,
  Version: "17.0",
  select: <T extends Record<string, unknown>>(obj: T) => obj.ios ?? obj.default,
  isPad: false,
  isTV: false,
  isTesting: true,
};

// Dimensions API
export const Dimensions = {
  get: () => ({ width: 375, height: 812, scale: 3, fontScale: 1 }),
  addEventListener: () => ({ remove: () => {} }),
  removeEventListener: () => {},
};

// StyleSheet API
export const StyleSheet = {
  create: <T extends Record<string, unknown>>(styles: T): T => styles,
  flatten: (style: unknown) => style,
  absoluteFill: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  absoluteFillObject: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  hairlineWidth: 1,
};

// Animated API
export const Animated = {
  View: createMockComponent("Animated.View"),
  Text: createMockComponent("Animated.Text"),
  Image: createMockComponent("Animated.Image"),
  ScrollView: createMockComponent("Animated.ScrollView"),
  FlatList: createMockComponent("Animated.FlatList"),
  Value: class {
    _value: number;
    constructor(value: number) {
      this._value = value;
    }
    setValue(value: number) {
      this._value = value;
    }
    interpolate() {
      return this;
    }
  },
  timing: () => ({ start: (cb?: () => void) => cb?.() }),
  spring: () => ({ start: (cb?: () => void) => cb?.() }),
  decay: () => ({ start: (cb?: () => void) => cb?.() }),
  sequence: () => ({ start: (cb?: () => void) => cb?.() }),
  parallel: () => ({ start: (cb?: () => void) => cb?.() }),
  loop: () => ({ start: (cb?: () => void) => cb?.() }),
  event: () => () => {},
  createAnimatedComponent: (component: unknown) => component,
};

// Keyboard API
export const Keyboard = {
  dismiss: () => {},
  addListener: () => ({ remove: () => {} }),
  removeListener: () => {},
  isVisible: () => false,
  scheduleLayoutAnimation: () => {},
};

// Alert API
export const Alert = {
  alert: () => {},
  prompt: () => {},
};

// Linking API
export const Linking = {
  openURL: async () => {},
  canOpenURL: async () => true,
  getInitialURL: async () => null,
  addEventListener: () => ({ remove: () => {} }),
};

// AppState API
export const AppState = {
  currentState: "active" as const,
  addEventListener: () => ({ remove: () => {} }),
  removeEventListener: () => {},
};

// PixelRatio API
export const PixelRatio = {
  get: () => 3,
  getFontScale: () => 1,
  getPixelSizeForLayoutSize: (size: number) => size * 3,
  roundToNearestPixel: (size: number) => size,
};

// useColorScheme hook
export const useColorScheme = () => "light";

// useWindowDimensions hook
export const useWindowDimensions = () => ({ width: 375, height: 812, scale: 3, fontScale: 1 });

// Default export
export default {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableHighlight,
  TouchableWithoutFeedback,
  Pressable,
  ScrollView,
  FlatList,
  SectionList,
  Image,
  ActivityIndicator,
  Modal,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
  Dimensions,
  StyleSheet,
  Animated,
  Keyboard,
  Alert,
  Linking,
  AppState,
  PixelRatio,
  useColorScheme,
  useWindowDimensions,
};
