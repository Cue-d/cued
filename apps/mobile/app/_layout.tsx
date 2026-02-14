import "../src/global.css";
import { useEffect, useRef } from "react";
import { ActivityIndicator, AppState, View, useColorScheme } from "react-native";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import * as Updates from "expo-updates";
import { Stack } from "expo-router/stack";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import {
  setCustomText,
  setCustomTextInput,
} from "react-native-global-props";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { PushTokenRegistrar } from "@/components/push-token-registrar";
import { ElectronPresenceProvider } from "@/contexts/electron-presence-context";
import { configureNotifications } from "@/lib/notifications";
import { getThemeColors } from "@/lib/utils";
import { AuthProvider, useAuth } from "@/providers/AuthProvider";
import { ConvexProvider } from "@/providers/ConvexProvider";
import { PostHogProvider } from "@/providers/PostHogProvider";
import SignInScreen from "./sign-in";

// Hide splash screen immediately since fonts are embedded at build time
SplashScreen.preventAutoHideAsync();

function useOTAUpdates() {
  useEffect(() => {
    if (__DEV__) return;

    async function checkForUpdate() {
      try {
        const update = await Updates.checkForUpdateAsync();
        if (update.isAvailable) {
          await Updates.fetchUpdateAsync();
          await Updates.reloadAsync();
        }
      } catch (e) {
        console.log("[OTA] Update check failed:", e);
      }
    }

    // Check on mount
    checkForUpdate();

    // Check when app comes to foreground
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        checkForUpdate();
      }
    });

    return () => subscription.remove();
  }, []);
}

// Set default font for all Text and TextInput components
const defaultFontStyle = { fontFamily: "Suisse Intl" };
setCustomText({ style: defaultFontStyle });
setCustomTextInput({ style: defaultFontStyle });

function LoadingScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-background">
      <ActivityIndicator size="large" />
    </View>
  );
}

function AuthenticatedApp() {
  const { isLoading, isAuthenticated } = useAuth();
  const router = useRouter();
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");
  const notificationResponseListener =
    useRef<Notifications.EventSubscription | null>(null);

  // Configure notification handlers on mount
  useEffect(() => {
    configureNotifications();
  }, []);

  // Handle notification tap navigation
  useEffect(() => {
    notificationResponseListener.current =
      Notifications.addNotificationResponseReceivedListener((response) => {
        const data = response.notification.request.content.data as {
          type?: string;
          id?: string;
          conversationId?: string;
        };

        if (!data?.type) {
          console.log("Notification tapped without type data");
          return;
        }

        // Navigate based on notification type
        if (data.type === "action" && data.id) {
          router.push(`/(tabs)/(actions)/${data.id}`);
        } else if (data.type === "message" && data.conversationId) {
          // Navigate to inbox/conversation detail
          // Note: inbox route may need to be created in future tasks
          router.push(`/(tabs)/(actions)`);
          console.log(
            "Message notification - conversation:",
            data.conversationId
          );
        }
      });

    // Clean up listener on unmount
    return () => {
      notificationResponseListener.current?.remove();
    };
  }, [router]);

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (!isAuthenticated) {
    return <SignInScreen />;
  }

  return (
    <ConvexProvider>
      <ElectronPresenceProvider>
        <PushTokenRegistrar />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen
            name="settings"
            options={{
              headerShown: false,
              presentation: "modal",
              contentStyle: { backgroundColor: colors.background },
            }}
          />
        </Stack>
      </ElectronPresenceProvider>
    </ConvexProvider>
  );
}

export default function RootLayout() {
  useOTAUpdates();
  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <PostHogProvider>
            <AuthenticatedApp />
          </PostHogProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
