/**
 * ContactListItem component for contacts list.
 * Modern iOS-style contact row with platform badges.
 */

import { View, Text, Pressable, useColorScheme } from "react-native";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { getInitials, type ActionPlatform } from "@cued/shared";
import { PlatformIcon } from "@/components/platform-icons";
import { ContactAvatar } from "@/components/contact-avatar";
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
      <ContactAvatar
        initials={initials}
        avatarUrl={contact.avatarUrl}
        size={40}
        fallbackTextClassName="text-muted-foreground font-semibold text-[15px]"
      />

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
