import { useColorScheme } from "react-native";
import { Stack } from "expo-router/stack";
import { HeaderAvatar } from "@/components/header-avatar";
import { getThemeColors } from "@/lib/utils";

export default function ActionsLayout(): React.JSX.Element {
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");

  return (
    <Stack
      screenOptions={{
        headerTransparent: true,
        headerLargeTitle: true,
        headerBlurEffect: "none",
        headerLargeStyle: { backgroundColor: "transparent" },
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: "",
          headerRight: () => <HeaderAvatar />,
        }}
      />
      <Stack.Screen
        name="snooze-picker"
        options={{
          headerShown: false,
          presentation: "formSheet",
          sheetAllowedDetents: [0.55, 0.95],
          contentStyle: { backgroundColor: "transparent" },
        }}
      />
      <Stack.Screen
        name="[id]"
        options={{
          headerLargeTitle: false,
        }}
      />
    </Stack>
  );
}
