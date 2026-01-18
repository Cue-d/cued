import { useColorScheme } from "react-native";
import {
  NativeTabs,
  NativeTabTrigger,
  Icon,
  Label,
  Badge,
} from "expo-router/unstable-native-tabs";
import { usePendingActionCount } from "@/hooks/usePendingActionCount";
import { getThemeColors } from "@/lib/utils";

export default function TabsLayout() {
  const count = usePendingActionCount();
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");

  return (
    <NativeTabs minimizeBehavior="onScrollDown" tintColor={colors.primary}>
      <NativeTabTrigger name="(actions)">
        <Icon sf={{ default: "tray", selected: "tray.fill" }} />
        <Label>Actions</Label>
        <Badge hidden={count === 0}>{count > 0 ? String(count) : undefined}</Badge>
      </NativeTabTrigger>

      <NativeTabTrigger name="(agent)">
        <Icon sf={{ default: "sparkles", selected: "sparkles" }} />
        <Label>Agent</Label>
      </NativeTabTrigger>

      <NativeTabTrigger name="(search)" role="search">
        <Label>Search</Label>
      </NativeTabTrigger>
    </NativeTabs>
  );
}
