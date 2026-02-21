/**
 * Contacts tab screen.
 *
 * Modern iOS-style contacts list with alphabetical sections,
 * colored avatars, and glass effect backgrounds.
 */

import { useState, useCallback, useMemo } from "react";
import {
  SectionList,
  RefreshControl,
  View,
  Text,
  Pressable,
  useColorScheme,
  type SectionListRenderItemInfo,
  type SectionListData,
} from "react-native";
import * as Haptics from "expo-haptics";
import { Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import {
  ContactListItem,
  type ContactListItemData,
} from "@/components/contact-list-item";
import { ErrorBoundary } from "@/components/error-boundary";
import { useContacts } from "@/hooks/useContacts";
import { getThemeColors, isRealContactName } from "@/lib/utils";

/** Section type for alphabetical grouping */
interface ContactSection {
  title: string;
  data: ContactListItemData[];
}

/** Map Convex contact to ContactListItemData */
function mapContact(contact: {
  _id: string;
  displayName: string;
  company?: string | null;
  avatarUrl?: string;
  handles?: { type: string; value: string; platform: string }[];
}): ContactListItemData {
  const phoneHandle = contact.handles?.find((h) => h.type === "phone");
  const emailHandle = contact.handles?.find((h) => h.type === "email");
  const platforms = [...new Set(contact.handles?.map((h) => h.platform) ?? [])];

  return {
    id: contact._id,
    displayName: contact.displayName,
    company: contact.company,
    avatarUrl: contact.avatarUrl,
    phoneNumber: phoneHandle?.value,
    email: emailHandle?.value,
    platforms,
  };
}

/** Group contacts by first letter */
function groupContactsByLetter(
  contacts: ContactListItemData[]
): ContactSection[] {
  const groups: Record<string, ContactListItemData[]> = {};

  for (const contact of contacts) {
    const name = contact.displayName.trim();
    let letter = name[0]?.toUpperCase() ?? "#";
    // Group non-alphabetic characters under #
    if (!/[A-Z]/i.test(letter)) {
      letter = "#";
    }
    if (!groups[letter]) {
      groups[letter] = [];
    }
    groups[letter].push(contact);
  }

  // Sort sections alphabetically, with # at the end
  const sortedLetters = Object.keys(groups).sort((a, b) => {
    if (a === "#") return 1;
    if (b === "#") return -1;
    return a.localeCompare(b);
  });

  return sortedLetters.map((letter) => ({
    title: letter,
    data: groups[letter].sort((a, b) =>
      a.displayName.localeCompare(b.displayName)
    ),
  }));
}

/** Section header component */
function SectionHeader({ title }: { title: string }) {
  return (
    <View className="px-4 py-1.5 bg-background">
      <Text className="text-sm font-semibold text-muted-foreground">
        {title}
      </Text>
    </View>
  );
}

/** Empty state component */
function EmptyState() {
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");

  return (
    <View className="flex-1 items-center justify-center p-8">
      <SymbolView name="person.2" tintColor={colors.mutedForeground} size={56} />
      <Text className="text-xl font-semibold text-foreground mt-4 text-center">
        No Contacts Yet
      </Text>
      <Text className="text-base text-muted-foreground mt-2 text-center max-w-[280px]">
        Contacts will appear here as you sync your messages and emails
      </Text>
    </View>
  );
}

/** Item separator */
function ItemSeparator() {
  return <View className="h-px bg-border" />;
}

/** Loading state */
function LoadingState() {
  return (
    <View className="flex-1 items-center justify-center p-8">
      <Text className="text-base text-muted-foreground">
        Loading contacts...
      </Text>
    </View>
  );
}

type ContactStatus = "active" | "archived";

/** Status filter tab bar */
function StatusFilterBar({
  selected,
  onSelect,
}: {
  selected: ContactStatus;
  onSelect: (s: ContactStatus) => void;
}) {
  const tabs: { key: ContactStatus; label: string }[] = [
    { key: "active", label: "Active" },
    { key: "archived", label: "Archived" },
  ];

  return (
    <View className="flex-row px-4 py-2 gap-2 bg-background">
      {tabs.map((tab) => (
        <Pressable
          key={tab.key}
          onPress={() => onSelect(tab.key)}
          className={`px-3 py-1.5 rounded-full ${
            selected === tab.key ? "bg-foreground" : "bg-muted"
          }`}
        >
          <Text
            className={`text-sm font-medium ${
              selected === tab.key ? "text-background" : "text-muted-foreground"
            }`}
          >
            {tab.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export default function ContactsScreen(): React.JSX.Element {
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ContactStatus>("active");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const { contacts, isLoading } = useContacts({
    searchQuery: searchQuery || undefined,
    status: statusFilter,
  });

  // Map and group contacts, filtering to named contacts only
  const sections = useMemo(() => {
    const mapped = contacts
      .filter((c) => isRealContactName(c.displayName))
      .map(mapContact);
    return groupContactsByLetter(mapped);
  }, [contacts]);

  // Handle pull-to-refresh
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await new Promise((resolve) => setTimeout(resolve, 500));
    setIsRefreshing(false);
  }, []);

  const renderItem = useCallback(
    ({ item }: SectionListRenderItemInfo<ContactListItemData, ContactSection>) => (
      <ContactListItem contact={item} />
    ),
    []
  );

  const renderSectionHeader = useCallback(
    ({ section }: { section: SectionListData<ContactListItemData, ContactSection> }) => (
      <SectionHeader title={section.title} />
    ),
    []
  );

  const keyExtractor = useCallback(
    (item: ContactListItemData) => item.id,
    []
  );

  if (isLoading) {
    return <LoadingState />;
  }

  const totalContacts = sections.reduce((sum, s) => sum + s.data.length, 0);

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
      <SectionList
        sections={sections}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        keyExtractor={keyExtractor}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        stickySectionHeadersEnabled
        ItemSeparatorComponent={ItemSeparator}
        ListHeaderComponent={
          <StatusFilterBar selected={statusFilter} onSelect={setStatusFilter} />
        }
        ListEmptyComponent={EmptyState}
        ListFooterComponent={
          totalContacts > 0 ? (
            <View className="py-6 items-center">
              <Text className="text-sm text-muted-foreground">
                {totalContacts} {totalContacts === 1 ? "Contact" : "Contacts"}
              </Text>
            </View>
          ) : null
        }
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />
        }
        className="bg-background"
      />
    </ErrorBoundary>
  );
}
