/**
 * Vitest setup for React Native / Expo mobile app testing
 * Provides global mocks for Expo modules and React Native dependencies
 */
import { vi } from "vitest";

// Mock @bacons/apple-targets (iOS widget extension storage)
vi.mock("@bacons/apple-targets", () => {
  class MockExtensionStorage {
    groupId: string;
    constructor(groupId: string) {
      this.groupId = groupId;
    }
    set = vi.fn();
    get = vi.fn().mockReturnValue(null);
    static reloadWidget = vi.fn();
  }
  return { ExtensionStorage: MockExtensionStorage };
});

// Mock expo-router
vi.mock("expo-router", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    canGoBack: () => true,
    setParams: vi.fn(),
  }),
  useLocalSearchParams: () => ({}),
  useGlobalSearchParams: () => ({}),
  useSegments: () => [],
  usePathname: () => "/",
  useNavigation: () => ({
    navigate: vi.fn(),
    goBack: vi.fn(),
    setOptions: vi.fn(),
  }),
  Link: ({ children }: { children: React.ReactNode }) => children,
  Stack: {
    Screen: ({ children }: { children?: React.ReactNode }) => children,
  },
  Tabs: {
    Screen: ({ children }: { children?: React.ReactNode }) => children,
  },
  router: {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    canGoBack: () => true,
    setParams: vi.fn(),
  },
}));

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
      name: "PRM",
      slug: "prm",
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
  createURL: (path: string) => `prm://${path}`,
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

// Mock react-native-reanimated
vi.mock("react-native-reanimated", () => ({
  default: {
    createAnimatedComponent: (component: unknown) => component,
    View: ({ children }: { children?: React.ReactNode }) => children,
    Text: ({ children }: { children?: React.ReactNode }) => children,
    Image: () => null,
    ScrollView: ({ children }: { children?: React.ReactNode }) => children,
  },
  useSharedValue: (initial: unknown) => ({ value: initial }),
  useAnimatedStyle: () => ({}),
  withTiming: (value: unknown) => value,
  withSpring: (value: unknown) => value,
  withDelay: (_: number, value: unknown) => value,
  withSequence: (...values: unknown[]) => values[values.length - 1],
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  runOnUI: (fn: (...args: unknown[]) => unknown) => fn,
  useDerivedValue: (fn: () => unknown) => ({ value: fn() }),
  useAnimatedScrollHandler: () => ({}),
  useAnimatedGestureHandler: () => ({}),
  FadeIn: { duration: () => ({ delay: () => ({}) }) },
  FadeOut: { duration: () => ({ delay: () => ({}) }) },
  FadeInUp: { duration: () => ({ delay: () => ({}) }) },
  FadeInDown: { duration: () => ({ delay: () => ({}) }) },
  FadeOutUp: { duration: () => ({ delay: () => ({}) }) },
  FadeOutDown: { duration: () => ({ delay: () => ({}) }) },
  SlideInRight: { duration: () => ({ delay: () => ({}) }) },
  SlideOutRight: { duration: () => ({ delay: () => ({}) }) },
  Layout: { duration: () => ({}) },
  Easing: {
    linear: (x: number) => x,
    ease: (x: number) => x,
    bezier: () => (x: number) => x,
  },
}));

// Mock react-native-gesture-handler
vi.mock("react-native-gesture-handler", () => ({
  GestureDetector: ({ children }: { children?: React.ReactNode }) => children,
  GestureHandlerRootView: ({ children }: { children?: React.ReactNode }) => children,
  Gesture: {
    Pan: () => ({
      onStart: () => ({}),
      onUpdate: () => ({}),
      onEnd: () => ({}),
      minDistance: () => ({}),
      activeOffsetX: () => ({}),
      activeOffsetY: () => ({}),
      failOffsetX: () => ({}),
      failOffsetY: () => ({}),
    }),
    Tap: () => ({
      onStart: () => ({}),
      onEnd: () => ({}),
      maxDuration: () => ({}),
      numberOfTaps: () => ({}),
    }),
    LongPress: () => ({
      onStart: () => ({}),
      onEnd: () => ({}),
      minDuration: () => ({}),
    }),
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
}));

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

// Note: @prm/convex/convex/_generated/api is mocked via vitest.config.ts alias to ./mocks/convex-api.ts

// Mock widget data (iOS specific)
vi.mock("@/lib/widget-data", () => ({
  updateWidgetData: vi.fn(),
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
