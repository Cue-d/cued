import { useEffect, useState } from "react";
import { Pressable, View, Text } from "react-native";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Image } from "expo-image";
import { getInitials } from "@cued/shared";
import { getDisplayName } from "@/lib/utils";
import { useAuth } from "@/providers/AuthProvider";

interface HeaderAvatarProps {
  size?: number;
}

export function HeaderAvatar({ size = 32 }: HeaderAvatarProps): React.ReactElement {
  const { user } = useAuth();
  const [imageFailed, setImageFailed] = useState(false);
  const displayName = getDisplayName(user);
  const initials = getInitials(displayName);
  const profilePhotoUrl = user?.profile_picture_url;

  useEffect(() => {
    setImageFailed(false);
  }, [profilePhotoUrl]);

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
        className="rounded-full bg-muted items-center justify-center"
        style={{ width: size, height: size }}
      >
        {profilePhotoUrl && !imageFailed ? (
          <Image
            source={{ uri: profilePhotoUrl }}
            style={{ width: size, height: size, borderRadius: size / 2 }}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={100}
            onError={() => setImageFailed(true)}
          />
        ) : (
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
        )}
      </View>
    </Pressable>
  );
}
