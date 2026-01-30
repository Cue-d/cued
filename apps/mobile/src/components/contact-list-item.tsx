/**
 * ContactListItem component for contacts list.
 * Modern iOS-style contact row.
 */

import { View, Text, Pressable, useColorScheme } from "react-native";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { getInitials } from "@cued/shared";
import { getThemeColors } from "@/lib/utils";

export interface ContactListItemData {
  id: string;
  displayName: string;
  company?: string | null;
  phoneNumber?: string | null;
  email?: string | null;
}

export interface ContactListItemProps {
  contact: ContactListItemData;
}

/** ContactListItem - Modern iOS-style contact row. */
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
      <View className="w-10 h-10 rounded-full bg-muted items-center justify-center">
        <Text className="text-muted-foreground font-semibold text-[15px]">
          {initials}
        </Text>
      </View>

      <View className="flex-1">
        <Text className="text-[17px] text-foreground" numberOfLines={1}>
          {contact.displayName}
        </Text>

        {contact.company && (
          <Text
            className="text-sm text-muted-foreground mt-0.5"
            numberOfLines={1}
          >
            {contact.company}
          </Text>
        )}
      </View>

      <SymbolView name="chevron.right" tintColor={colors.mutedForeground} size={14} />
    </Pressable>
  );
}

export default ContactListItem;
