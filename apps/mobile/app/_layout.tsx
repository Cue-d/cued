import "../src/global.css";
import {
  NativeTabs,
  NativeTabTrigger,
  Icon,
  Label,
  Badge,
} from "expo-router/unstable-native-tabs";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConvexProvider } from "@/providers/ConvexProvider";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ConvexProvider>
        <NativeTabs minimizeBehavior="onScrollDown">
          <NativeTabTrigger name="(actions)">
            <Icon sf={{ default: "tray", selected: "tray.fill" }} />
            <Label>Actions</Label>
            <Badge />
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
      </ConvexProvider>
    </SafeAreaProvider>
  );
}
