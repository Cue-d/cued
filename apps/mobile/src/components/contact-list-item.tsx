/**
 * ContactListItem component for contacts list.
 * Modern iOS-style contact row with platform badges.
 */

import { useEffect, useState } from "react";
import { View, Text, Pressable, useColorScheme } from "react-native";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { Image } from "expo-image";
import { getInitials, type ActionPlatform } from "@cued/shared";
import { PlatformIcon } from "@/components/platform-icons";
import { getThemeColors } from "@/lib/utils";

export interface ContactListItemData {
  id: string;
  displayName: string;
  company?: string | null;
  avatarUrl?: string;
  phoneNumber?: string | null;
  email?: string | null;
  platforms?: string[];
}

export interface ContactListItemProps {
  contact: ContactListItemData;
}

/** ContactListItem - Modern iOS-style contact row with platform indicators. */
export function ContactListItem({
  contact,
}: ContactListItemProps): React.JSX.Element {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");
  const initials = getInitials(contact.displayName);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [contact.avatarUrl]);

  const handlePress = () => {
    Haptics.selectionAsync();
    router.push(`/(tabs)/(contacts)/${contact.id}`);
  };

  return (
    <Pressable
      onPress={handlePress}
      className="flex-row items-center py-3 px-4 gap-3 active:bg-muted"
      accessibilityRole="button"
      accessibilityLabel={`View ${contact.displayName}`}
    >
      <View className="w-10 h-10 rounded-full bg-muted items-center justify-center">
        {contact.avatarUrl && !imageFailed ? (
          <Image
            source={{ uri: contact.avatarUrl }}
            style={{ width: 40, height: 40, borderRadius: 20 }}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={120}
            onError={() => setImageFailed(true)}
          />
        ) : (
          <Text className="text-muted-foreground font-semibold text-[15px]">
            {initials}
          </Text>
        )}
      </View>

      <View className="flex-1">
        <Text className="text-[17px] text-foreground" numberOfLines={1}>
          {contact.displayName}
        </Text>

        <View className="flex-row items-center gap-2 mt-0.5">
          {contact.company && (
            <Text
              className="text-sm text-muted-foreground"
              numberOfLines={1}
            >
              {contact.company}
            </Text>
          )}
          {contact.platforms && contact.platforms.length > 0 && (
            <View className="flex-row items-center gap-1.5">
              {contact.platforms.map((platform) => (
                <PlatformIcon
                  key={platform}
                  platform={platform as ActionPlatform}
                  size={14}
                />
              ))}
            </View>
          )}
        </View>
      </View>

      <SymbolView name="chevron.right" tintColor={colors.mutedForeground} size={14} />
    </Pressable>
  );
}

export default ContactListItem;
