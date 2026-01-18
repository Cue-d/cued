import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { Pressable, View, Text } from "react-native";
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
      accessibilityLabel="Open settings"
      accessibilityRole="button"
    >
      <View
        className="relative items-center justify-center text-center rounded-full"
        style={{ width: size, height: size }}
      >
        <Text
          className="font-medium text-muted-foreground"
          style={{
            fontSize: size * 0.45,
            lineHeight: size * 0.5,
            includeFontPadding: false,
            textAlignVertical: "center",
          }}
        >
          {initials}
        </Text>
      </View>
    </Pressable>
  );
}
