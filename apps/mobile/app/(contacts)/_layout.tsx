import { Stack } from "expo-router/stack";

export default function ContactsLayout() {
  return (
    <Stack
      screenOptions={{
        headerTransparent: true,
        headerLargeTitle: true,
        headerBlurEffect: "none",
        headerLargeStyle: { backgroundColor: "transparent" },
      }}
    >
      <Stack.Screen name="index" options={{ title: "Contacts" }} />
      <Stack.Screen
        name="[id]"
        options={{
          headerLargeTitle: false,
        }}
      />
    </Stack>
  );
}
