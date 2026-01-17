import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { Pressable, View, Text } from "@/tw";
import { useAuth } from "@/providers/AuthProvider";
import { getDisplayName, getInitials } from "@/lib/utils";

interface HeaderAvatarProps {
  size?: number;
}

export function HeaderAvatar({ size = 32 }: HeaderAvatarProps): React.ReactElement {
  const { user } = useAuth();
  const displayName = getDisplayName(user);
  const initials = getInitials(displayName);

  function handlePress(): void {
    Haptics.selectionAsync();
    router.push("/settings");
  }

  return (
    <Pressable
      onPress={handlePress}
      className="active:opacity-70"
      accessibilityLabel="Open settings"
      accessibilityRole="button"
    >
      <View
        className="items-center justify-center rounded-full bg-sf-blue"
        style={{ width: size, height: size }}
      >
        <Text className="font-semibold text-white" style={{ fontSize: size * 0.4 }}>
          {initials}
        </Text>
      </View>
    </Pressable>
  );
}
