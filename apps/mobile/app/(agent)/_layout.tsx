import { Stack } from "expo-router/stack";

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
      <Stack.Screen name="index" options={{ title: "Assistant" }} />
    </Stack>
  );
}
