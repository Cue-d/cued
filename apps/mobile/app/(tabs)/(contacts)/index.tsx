/**
 * Contacts tab screen.
 *
 * Task 8.3: Implement Contacts tab with FlatList
 * Task 8.4: Add search to Contacts tab
 * - Import useContacts hook
 * - Use FlatList from react-native with contentInsetAdjustmentBehavior
 * - Render ContactListItem for each contact
 * - Add keyExtractor using contact.id
 * - Use Stack.Screen onChangeText to get search text
 * - Pass searchQuery to useContacts for filtering
 */

import { useState, useCallback } from "react";
import { FlatList, RefreshControl, type ListRenderItemInfo } from "react-native";
import { Stack } from "expo-router";
import * as Haptics from "expo-haptics";
import { View, Text } from "@/tw";
import { useContacts } from "@/hooks/useContacts";
import {
  ContactListItem,
  type ContactListItemData,
} from "@/components/contact-list-item";
import { ErrorBoundary } from "@/components/error-boundary";

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
  const [searchQuery, setSearchQuery] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const { contacts, isLoading } = useContacts({
    searchQuery: searchQuery || undefined,
  });

  // Map Convex contacts to ContactListItemData
  const mappedContacts = contacts.map(mapContact);

  // Handle pull-to-refresh
  // Convex has real-time updates, so we just show refresh indicator for UX
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Convex updates automatically, simulate brief refresh for UX
    await new Promise((resolve) => setTimeout(resolve, 500));
    setIsRefreshing(false);
  }, []);

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center">
        <Text className="text-sf-secondaryLabel">Loading contacts...</Text>
      </View>
    );
  }

  return (
    <ErrorBoundary>
      <Stack.Screen
        options={{
          headerSearchBarOptions: {
            placeholder: "Search contacts",
            onChangeText: (event) => setSearchQuery(event.nativeEvent.text),
          },
        }}
      />
      <FlatList
        data={mappedContacts}
        renderItem={renderContactItem}
        keyExtractor={keyExtractor}
        contentInsetAdjustmentBehavior="automatic"
        ListEmptyComponent={EmptyState}
        ItemSeparatorComponent={ItemSeparator}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor="#8E8E93"
          />
        }
      />
    </ErrorBoundary>
  );
}
