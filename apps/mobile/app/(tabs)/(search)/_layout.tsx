import { Stack } from "expo-router/stack";
import { HeaderAvatar } from "@/components/header-avatar";

export default function SearchLayout(): React.JSX.Element {
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
      <Stack.Screen
        name="[contactId]"
        options={{
          headerLargeTitle: false,
        }}
      />
    </Stack>
  );
}
