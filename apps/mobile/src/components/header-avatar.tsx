import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { Pressable, View, Text } from "react-native";
import { getInitials } from "@prm/shared";
import { useAuth } from "@/providers/AuthProvider";
import { getDisplayName } from "@/lib/utils";

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
      accessibilityLabel="Open settings"
      accessibilityRole="button"
    >
      <View
        className="rounded-full"
        style={{ width: size, height: size }}
      >
        <Text
          className="font-bold ml-[1] text-muted-foreground"
          style={{
            width: size,
            fontSize: size * 0.5,
            lineHeight: size,
            textAlign: "center",
            textAlignVertical: "center",
          }}
        >
          {initials}
        </Text>
      </View>
    </Pressable>
  );
}
