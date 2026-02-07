/**
 * Vitest setup for React Native / Expo mobile app testing
 * Provides global mocks for Expo modules and React Native dependencies
 */
import React from "react";
import { vi } from "vitest";

// Ensure React is globally available for JSX transform in components
globalThis.React = React;

// Define __DEV__ as false to skip expo dev-only code paths that try to load metro modules
(globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;

// Note: expo-widgets and expo/fetch are mocked via vitest.config.ts aliases

// Mock expo-router - store mock functions so tests can access them
const mockRouterPush = vi.fn();
const mockRouterReplace = vi.fn();
const mockRouterBack = vi.fn();
const mockRouterSetParams = vi.fn();

vi.mock("expo-router", () => ({
  useRouter: vi.fn(() => ({
    push: mockRouterPush,
    replace: mockRouterReplace,
    back: mockRouterBack,
    canGoBack: () => true,
    setParams: mockRouterSetParams,
  })),
  useLocalSearchParams: vi.fn(() => ({})),
  useGlobalSearchParams: vi.fn(() => ({})),
  useSegments: vi.fn(() => []),
  usePathname: vi.fn(() => "/"),
  useNavigation: vi.fn(() => ({
    navigate: vi.fn(),
    goBack: vi.fn(),
    setOptions: vi.fn(),
  })),
  Link: ({ children }: { children: React.ReactNode }) => children,
  Stack: {
    Screen: ({ children }: { children?: React.ReactNode }) => children,
  },
  Tabs: {
    Screen: ({ children }: { children?: React.ReactNode }) => children,
  },
  router: {
    push: mockRouterPush,
    replace: mockRouterReplace,
    back: mockRouterBack,
    canGoBack: () => true,
    setParams: mockRouterSetParams,
  },
}));

// Export mocks for test files to access
export { mockRouterPush, mockRouterReplace, mockRouterBack, mockRouterSetParams };

// Mock expo-status-bar
vi.mock("expo-status-bar", () => ({
  StatusBar: () => null,
  setStatusBarStyle: vi.fn(),
  setStatusBarHidden: vi.fn(),
}));

// Mock expo-haptics
vi.mock("expo-haptics", () => ({
  impactAsync: vi.fn(),
  notificationAsync: vi.fn(),
  selectionAsync: vi.fn(),
  ImpactFeedbackStyle: {
    Light: "light",
    Medium: "medium",
    Heavy: "heavy",
  },
  NotificationFeedbackType: {
    Success: "success",
    Warning: "warning",
    Error: "error",
  },
}));

// Mock expo-secure-store
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn().mockResolvedValue(null),
  setItemAsync: vi.fn().mockResolvedValue(undefined),
  deleteItemAsync: vi.fn().mockResolvedValue(undefined),
}));

// Mock expo-constants
vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      name: "Cued",
      slug: "cued",
      extra: {},
    },
    manifest: null,
    executionEnvironment: "bare",
  },
}));

// Mock expo-device
vi.mock("expo-device", () => ({
  isDevice: true,
  brand: "Apple",
  manufacturer: "Apple",
  modelName: "iPhone 15",
  modelId: "iPhone15,3",
  osName: "iOS",
  osVersion: "17.0",
  platformApiLevel: null,
  deviceYearClass: 2023,
}));

// Mock expo-notifications
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn().mockResolvedValue({ status: "granted" }),
  requestPermissionsAsync: vi.fn().mockResolvedValue({ status: "granted" }),
  getExpoPushTokenAsync: vi.fn().mockResolvedValue({ data: "mock-push-token" }),
  setNotificationHandler: vi.fn(),
  addNotificationReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
  addNotificationResponseReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
  scheduleNotificationAsync: vi.fn(),
  cancelScheduledNotificationAsync: vi.fn(),
  cancelAllScheduledNotificationsAsync: vi.fn(),
  setBadgeCountAsync: vi.fn(),
  getBadgeCountAsync: vi.fn().mockResolvedValue(0),
}));

// Mock expo-clipboard
vi.mock("expo-clipboard", () => ({
  setStringAsync: vi.fn(),
  getStringAsync: vi.fn().mockResolvedValue(""),
  hasStringAsync: vi.fn().mockResolvedValue(false),
}));

// Mock expo-linking
vi.mock("expo-linking", () => ({
  createURL: (path: string) => `cued://${path}`,
  parse: (url: string) => ({ path: url, queryParams: {} }),
  openURL: vi.fn(),
  canOpenURL: vi.fn().mockResolvedValue(true),
  useURL: () => null,
}));

// Mock expo-blur
vi.mock("expo-blur", () => ({
  BlurView: ({ children }: { children?: React.ReactNode }) => children,
}));

// Mock expo-image
vi.mock("expo-image", () => ({
  Image: ({ source, style, ...props }: { source?: unknown; style?: unknown; [key: string]: unknown }) => null,
}));

// Mock expo-symbols
vi.mock("expo-symbols", () => ({
  SymbolView: () => null,
  SFSymbol: {},
}));

// Mock react-native-svg
vi.mock("react-native-svg", () => ({
  default: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("svg", null, children),
  Circle: (props: Record<string, unknown>) =>
    React.createElement("circle", props),
  Rect: (props: Record<string, unknown>) =>
    React.createElement("rect", props),
  Path: (props: Record<string, unknown>) =>
    React.createElement("path", props),
  Svg: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("svg", null, children),
}));

// Mock expo-glass-effect
vi.mock("expo-glass-effect", () => ({
  GlassView: ({ children }: { children?: React.ReactNode }) => children,
  isLiquidGlassAvailable: () => false,
}));

// Mock react-native-reanimated
vi.mock("react-native-reanimated", () => {
  // Create a chainable animation mock that supports all common methods
  const createChainableAnimation = () => {
    const animation: Record<string, unknown> = {};
    const chainMethods = ["duration", "delay", "springify", "damping", "stiffness", "easing"];
    chainMethods.forEach(method => {
      animation[method] = () => animation;
    });
    return animation;
  };

  return {
    default: {
      createAnimatedComponent: (component: unknown) => component,
      View: ({ children }: { children?: React.ReactNode }) => children,
      Text: ({ children }: { children?: React.ReactNode }) => children,
      Image: () => null,
      ScrollView: ({ children }: { children?: React.ReactNode }) => children,
    },
    useSharedValue: (initial: unknown) => ({ value: initial }),
    useAnimatedStyle: () => ({}),
    useAnimatedProps: () => ({}),
    useAnimatedKeyboard: () => ({ height: { value: 0 } }),
    withTiming: (value: unknown) => value,
    withSpring: (value: unknown) => value,
    withDelay: (_: number, value: unknown) => value,
    withSequence: (...values: unknown[]) => values[values.length - 1],
    runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
    runOnUI: (fn: (...args: unknown[]) => unknown) => fn,
    useDerivedValue: (fn: () => unknown) => ({ value: fn() }),
    useAnimatedScrollHandler: () => ({}),
    useAnimatedGestureHandler: () => ({}),
    interpolateColor: (progress: number, inputRange: number[], outputRange: string[]) =>
      progress < 0.5 ? outputRange[0] : outputRange[1],
    FadeIn: createChainableAnimation(),
    FadeOut: createChainableAnimation(),
    FadeInUp: createChainableAnimation(),
    FadeInDown: createChainableAnimation(),
    FadeOutUp: createChainableAnimation(),
    FadeOutDown: createChainableAnimation(),
    SlideInRight: createChainableAnimation(),
    SlideOutRight: createChainableAnimation(),
    Layout: createChainableAnimation(),
    LinearTransition: createChainableAnimation(),
    Easing: {
      linear: (x: number) => x,
      ease: (x: number) => x,
      out: (fn: (x: number) => number) => fn,
      bezier: () => (x: number) => x,
    },
  };
});

// Mock react-native-gesture-handler
vi.mock("react-native-gesture-handler", () => {
  // Create a chainable gesture mock that returns itself for all methods
  const createChainableGesture = () => {
    const gesture: Record<string, unknown> = {};
    const chainMethods = [
      "onStart", "onUpdate", "onEnd", "onFinalize", "onTouchesDown", "onTouchesMove", "onTouchesUp",
      "minDistance", "activeOffsetX", "activeOffsetY", "failOffsetX", "failOffsetY",
      "enabled", "shouldCancelWhenOutside", "hitSlop", "simultaneousWithExternalGesture",
      "withTestId", "runOnJS", "maxDuration", "numberOfTaps", "minDuration", "maxPointers", "minPointers"
    ];
    chainMethods.forEach(method => {
      gesture[method] = () => gesture;
    });
    return gesture;
  };

  return {
    GestureDetector: ({ children }: { children?: React.ReactNode }) => children,
    GestureHandlerRootView: ({ children }: { children?: React.ReactNode }) => children,
    Gesture: {
      Pan: createChainableGesture,
      Tap: createChainableGesture,
      LongPress: createChainableGesture,
      Pinch: createChainableGesture,
      Rotation: createChainableGesture,
      Fling: createChainableGesture,
      Native: createChainableGesture,
      Manual: createChainableGesture,
      Simultaneous: () => ({}),
      Exclusive: () => ({}),
      Race: () => ({}),
    },
    Swipeable: ({ children }: { children?: React.ReactNode }) => children,
    DrawerLayout: ({ children }: { children?: React.ReactNode }) => children,
    State: {},
    PanGestureHandler: ({ children }: { children?: React.ReactNode }) => children,
    TapGestureHandler: ({ children }: { children?: React.ReactNode }) => children,
    LongPressGestureHandler: ({ children }: { children?: React.ReactNode }) => children,
  };
});

// Mock react-native-safe-area-context
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: ({ children }: { children?: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children?: React.ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 375, height: 812 }),
}));

// Mock react-native-mmkv
vi.mock("react-native-mmkv", () => ({
  MMKV: class {
    getString = vi.fn().mockReturnValue(undefined);
    set = vi.fn();
    delete = vi.fn();
    contains = vi.fn().mockReturnValue(false);
    clearAll = vi.fn();
  },
}));

// Mock convex/react
vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(() => vi.fn()),
  useAction: vi.fn(() => vi.fn()),
  useConvex: vi.fn(),
  ConvexProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

// Note: @cued/convex/convex/_generated/api is mocked via vitest.config.ts alias to ./mocks/convex-api.ts

// Mock widget data (iOS specific)
vi.mock("@/lib/widget-data", () => ({
  updateWidgetData: vi.fn(),
  updateWidgetActionsList: vi.fn(),
}));

// Silence console warnings during tests (optional)
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  // Filter out known React Native warnings during tests
  const message = args[0]?.toString() || "";
  if (
    message.includes("Animated:") ||
    message.includes("VirtualizedLists") ||
    message.includes("componentWillReceiveProps") ||
    message.includes("componentWillMount")
  ) {
    return;
  }
  originalWarn(...args);
};
