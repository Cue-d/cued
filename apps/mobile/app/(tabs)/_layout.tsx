import { useColorScheme } from "react-native";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { usePendingActionCount } from "@/hooks/usePendingActionCount";
import { getThemeColors } from "@/lib/utils";

export default function TabsLayout() {
  const count = usePendingActionCount();
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");

  return (
    <NativeTabs minimizeBehavior="onScrollDown" tintColor={colors.primary}>
      <NativeTabs.Trigger name="(actions)">
        <NativeTabs.Trigger.Icon sf={{ default: "tray", selected: "tray.fill" }} />
        <NativeTabs.Trigger.Label>Actions</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Badge hidden={count === 0}>
          {count > 0 ? String(count) : undefined}
        </NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="(agent)">
        <NativeTabs.Trigger.Icon sf={{ default: "sparkles", selected: "sparkles" }} />
        <NativeTabs.Trigger.Label>Agent</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="(search)" role="search">
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
