import "../src/global.css";
import { useEffect } from "react";
import { ActivityIndicator } from "react-native";
import { Stack } from "expo-router/stack";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { View } from "@/tw";
import { AuthProvider, useAuth } from "@/providers/AuthProvider";
import { ConvexProvider } from "@/providers/ConvexProvider";
import { PushTokenRegistrar } from "@/components/push-token-registrar";
import { configureNotifications } from "@/lib/notifications";
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

  // Configure notification handlers on mount
  useEffect(() => {
    configureNotifications();
  }, []);

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
            headerShown: true,
            headerLargeTitle: true,
            headerTransparent: true,
            headerBlurEffect: "systemMaterial",
            title: "Settings",
            presentation: "modal",
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
