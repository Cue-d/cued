import { Pressable, View, Text } from "react-native";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { getInitials } from "@cued/shared";
import { getDisplayName } from "@/lib/utils";
import { useAuth } from "@/providers/AuthProvider";

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
          className="font-bold text-muted-foreground"
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
