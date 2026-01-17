import { Stack } from "expo-router/stack";
import { HeaderAvatar } from "@/components/header-avatar";

export default function AgentLayout() {
  return (
    <Stack
      screenOptions={{
        headerTransparent: true,
        headerLargeTitle: true,
        headerBlurEffect: "none",
        headerLargeStyle: { backgroundColor: "transparent" },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: "Assistant",
          headerRight: () => <HeaderAvatar />,
        }}
      />
    </Stack>
  );
}
