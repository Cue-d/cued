import { Stack } from "expo-router/stack";
import { HeaderAvatar } from "@/components/header-avatar";

export default function SearchLayout() {
  return (
    <Stack
      screenOptions={{
        headerTransparent: true,
        headerBlurEffect: "none",
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
