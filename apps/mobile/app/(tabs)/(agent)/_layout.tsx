import { useColorScheme } from "react-native";
import { Stack } from "expo-router/stack";
import { HeaderAvatar } from "@/components/header-avatar";
import { getThemeColors } from "@/lib/utils";

export default function AgentLayout() {
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
    </Stack>
  );
}
