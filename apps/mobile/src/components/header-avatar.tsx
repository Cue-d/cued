import { Pressable } from "react-native";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { getInitials } from "@cued/shared";
import { getDisplayName } from "@/lib/utils";
import { useAuth } from "@/providers/AuthProvider";
import { ContactAvatar } from "@/components/contact-avatar";

interface HeaderAvatarProps {
  size?: number;
}

export function HeaderAvatar({ size = 32 }: HeaderAvatarProps): React.ReactElement {
  const { user } = useAuth();
  const displayName = getDisplayName(user);
  const initials = getInitials(displayName);
  const profilePhotoUrl = user?.profile_picture_url;

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
      <ContactAvatar
        initials={initials}
        avatarUrl={profilePhotoUrl}
        size={size}
        fallbackTextClassName="font-bold text-muted-foreground"
        fallbackTextStyle={{
          fontSize: size * 0.5,
          lineHeight: size,
          textAlign: "center",
          textAlignVertical: "center",
        }}
        transition={100}
      />
    </Pressable>
  );
}
