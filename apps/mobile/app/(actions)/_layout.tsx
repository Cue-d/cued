import { Stack } from "expo-router/stack";

export default function ActionsLayout() {
  return (
    <Stack
      screenOptions={{
        headerTransparent: true,
        headerLargeTitle: true,
        headerBlurEffect: "none",
        headerLargeStyle: { backgroundColor: "transparent" },
      }}
    >
      <Stack.Screen name="index" options={{ title: "Actions" }} />
      <Stack.Screen
        name="snooze-picker"
        options={{
          title: "Snooze",
          presentation: "formSheet",
          sheetGrabberVisible: true,
          sheetAllowedDetents: [0.4],
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
