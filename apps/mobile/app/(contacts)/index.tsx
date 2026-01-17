/**
 * Contacts tab screen.
 *
 * Task 8.3: Implement Contacts tab with FlatList
 * - Import useContacts hook
 * - Use FlatList from react-native with contentInsetAdjustmentBehavior
 * - Render ContactListItem for each contact
 * - Add keyExtractor using contact.id
 */

import { FlatList, type ListRenderItemInfo } from "react-native";
import { View, Text } from "@/tw";
import { useContacts } from "@/hooks/useContacts";
import {
  ContactListItem,
  type ContactListItemData,
} from "@/components/contact-list-item";

/** Map Convex contact to ContactListItemData */
function mapContact(contact: {
  _id: string;
  displayName: string;
  company?: string | null;
  handles?: { type: string; value: string; platform: string }[];
}): ContactListItemData {
  // Extract phone number and email from handles
  const phoneHandle = contact.handles?.find((h) => h.type === "phone");
  const emailHandle = contact.handles?.find((h) => h.type === "email");

  return {
    id: contact._id,
    displayName: contact.displayName,
    company: contact.company,
    phoneNumber: phoneHandle?.value,
    email: emailHandle?.value,
  };
}

/** Render each contact list item */
function renderContactItem({
  item,
}: ListRenderItemInfo<ContactListItemData>): React.JSX.Element {
  return <ContactListItem contact={item} />;
}

/** Key extractor for FlatList */
function keyExtractor(item: ContactListItemData): string {
  return item.id;
}

/** Empty state component */
function EmptyState(): React.JSX.Element {
  return (
    <View className="flex-1 items-center justify-center p-8">
      <Text className="text-sf-secondaryLabel text-lg text-center">
        No contacts yet
      </Text>
      <Text className="text-sf-tertiaryLabel text-sm text-center mt-2">
        Contacts will appear here as you sync your messages
      </Text>
    </View>
  );
}

/** Separator between contact items */
function ItemSeparator(): React.JSX.Element {
  return <View className="h-px bg-sf-separator ml-16" />;
}

export default function ContactsScreen(): React.JSX.Element {
  const { contacts, isLoading } = useContacts();

  // Map Convex contacts to ContactListItemData
  const mappedContacts = contacts.map(mapContact);

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center">
        <Text className="text-sf-secondaryLabel">Loading contacts...</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={mappedContacts}
      renderItem={renderContactItem}
      keyExtractor={keyExtractor}
      contentInsetAdjustmentBehavior="automatic"
      ListEmptyComponent={EmptyState}
      ItemSeparatorComponent={ItemSeparator}
    />
  );
}
