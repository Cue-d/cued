import { useColorScheme } from "react-native";
import { Stack } from "expo-router/stack";
import { HeaderAvatar } from "@/components/header-avatar";
import { getThemeColors } from "@/lib/utils";

export default function SearchLayout(): React.JSX.Element {
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");

  return (
    <Stack
      screenOptions={{
        headerTransparent: true,
        headerBlurEffect: "none",
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
        name="[contactId]"
        options={{
          headerLargeTitle: false,
        }}
      />
    </Stack>
  );
}
