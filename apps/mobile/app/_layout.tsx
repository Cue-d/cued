import "../src/global.css";
import { ActivityIndicator } from "react-native";
import {
  NativeTabs,
  NativeTabTrigger,
  Icon,
  Label,
  Badge,
} from "expo-router/unstable-native-tabs";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { View } from "@/tw";
import { AuthProvider, useAuth } from "@/providers/AuthProvider";
import { ConvexProvider } from "@/providers/ConvexProvider";
import { usePendingActionCount } from "@/hooks/usePendingActionCount";
import SignInScreen from "./sign-in";

function TabsWithBadge() {
  const count = usePendingActionCount();

  return (
    <NativeTabs minimizeBehavior="onScrollDown">
      <NativeTabTrigger name="(actions)">
        <Icon sf={{ default: "tray", selected: "tray.fill" }} />
        <Label>Actions</Label>
        <Badge hidden={count === 0}>{count > 0 ? String(count) : undefined}</Badge>
      </NativeTabTrigger>

      <NativeTabTrigger name="(contacts)">
        <Icon sf={{ default: "person.2", selected: "person.2.fill" }} />
        <Label>Contacts</Label>
      </NativeTabTrigger>

      <NativeTabTrigger name="(agent)">
        <Icon sf={{ default: "sparkles", selected: "sparkles" }} />
        <Label>Agent</Label>
      </NativeTabTrigger>
    </NativeTabs>
  );
}

function LoadingScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-neutral-50 dark:bg-black">
      <ActivityIndicator size="large" />
    </View>
  );
}

function AuthenticatedApp() {
  const { isLoading, isAuthenticated } = useAuth();

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (!isAuthenticated) {
    return <SignInScreen />;
  }

  return (
    <ConvexProvider>
      <TabsWithBadge />
    </ConvexProvider>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <AuthenticatedApp />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
