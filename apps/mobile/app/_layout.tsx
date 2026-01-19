import "../src/global.css";
import { useEffect, useRef } from "react";
import { ActivityIndicator, View, useColorScheme } from "react-native";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { Stack } from "expo-router/stack";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { PushTokenRegistrar } from "@/components/push-token-registrar";
import { configureNotifications } from "@/lib/notifications";
import { getThemeColors } from "@/lib/utils";
import { AuthProvider, useAuth } from "@/providers/AuthProvider";
import { ConvexProvider } from "@/providers/ConvexProvider";
import SignInScreen from "./sign-in";

function LoadingScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-neutral-50 dark:bg-black">
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
      <PushTokenRegistrar />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="settings"
          options={{
            headerShown: false,
            presentation: "modal",
            contentStyle: { backgroundColor: colors.secondaryBackground },
          }}
        />
      </Stack>
    </ConvexProvider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <AuthenticatedApp />
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
