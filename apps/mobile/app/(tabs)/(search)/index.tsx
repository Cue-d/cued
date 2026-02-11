import { useState, useMemo, useCallback } from "react";
import { View, Text, FlatList, ScrollView, Pressable, PlatformColor, ActivityIndicator } from "react-native";
import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { Stack, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { usePaginatedQuery } from "convex/react";
import { api } from "@cued/convex";
import { useSearch, type SearchContactResult, type SearchMessageResult } from "@/hooks/useSearch";
import { PlatformIcon } from "@/components/platform-icons";
import { isRealContactName } from "@/lib/utils";
import { type ActionPlatform } from "@cued/shared";

const AVATAR_SIZE = 40;
const PAGE_SIZE = 50;

const avatarStyle = {
  width: AVATAR_SIZE,
  height: AVATAR_SIZE,
  borderRadius: AVATAR_SIZE / 2,
  backgroundColor: PlatformColor("systemGray5"),
  alignItems: "center" as const,
  justifyContent: "center" as const,
};

interface AdaptiveGlassProps {
  children: React.ReactNode;
  style?: object;
}

function AdaptiveGlass({ children, style }: AdaptiveGlassProps): React.ReactElement {
  if (isLiquidGlassAvailable()) {
    return <GlassView style={style}>{children}</GlassView>;
  }

  return (
    <BlurView tint="systemMaterial" intensity={80} style={[style, { overflow: "hidden" }]}>
      {children}
    </BlurView>
  );
}

function ContactResultCard({ contact }: { contact: SearchContactResult }): React.ReactElement {
  const router = useRouter();
  const phoneHandle = contact.handles.find((h) => h.type === "phone");
  const emailHandle = contact.handles.find((h) => h.type === "email");
  const subtitle = contact.company || phoneHandle?.value || emailHandle?.value;
  const platforms = [...new Set(contact.handles.map((h) => h.platform))];

  const handlePress = () => {
    Haptics.selectionAsync();
    router.push({
      pathname: "/(tabs)/(search)/[contactId]",
      params: { contactId: contact._id },
    });
  };

  return (
    <Pressable
      onPress={handlePress}
      style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, gap: 12 }}
    >
        <View style={avatarStyle}>
          <SymbolView name="person.fill" tintColor={PlatformColor("secondaryLabel")} size={20} />
        </View>
        <View style={{ flex: 1 }}>
          <Text
            style={{ fontSize: 16, fontWeight: "500", color: PlatformColor("label") }}
            numberOfLines={1}
          >
            {contact.displayName}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
            {subtitle && (
              <Text
                style={{ fontSize: 14, color: PlatformColor("secondaryLabel") }}
                numberOfLines={1}
              >
                {subtitle}
              </Text>
            )}
            {platforms.length > 0 && (
              <View style={{ flexDirection: "row", gap: 4, alignItems: "center" }}>
                {platforms.map((platform) => (
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
        <SymbolView name="chevron.right" tintColor={PlatformColor("tertiaryLabel")} size={14} />
    </Pressable>
  );
}

function formatMessageDate(sentAt: number): string {
  const date = new Date(sentAt);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function MessageResultCard({ message }: { message: SearchMessageResult }): React.ReactElement {
  const formattedDate = useMemo(() => formatMessageDate(message.sentAt), [message.sentAt]);
  const displayName = message.conversationName || message.senderName || "Unknown";
  const messagePreview = message.isFromMe ? `You: ${message.content}` : message.content;

  return (
    <Pressable
      onPressIn={() => Haptics.selectionAsync()}
      style={{ flexDirection: "row", alignItems: "flex-start", padding: 12, gap: 12 }}
    >
      <View style={avatarStyle}>
        <PlatformIcon platform={message.platform} size={20} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text
            style={{ fontSize: 16, fontWeight: "500", color: PlatformColor("label"), flex: 1 }}
            numberOfLines={1}
          >
            {displayName}
          </Text>
          <Text style={{ fontSize: 13, color: PlatformColor("tertiaryLabel"), marginLeft: 8 }}>
            {formattedDate}
          </Text>
        </View>
        <Text
          style={{ fontSize: 14, color: PlatformColor("secondaryLabel"), marginTop: 2 }}
          numberOfLines={2}
        >
          {messagePreview}
        </Text>
      </View>
    </Pressable>
  );
}

function SectionHeader({ title }: { title: string }): React.ReactElement {
  return (
    <View style={{ paddingHorizontal: 4, paddingVertical: 8 }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: PlatformColor("secondaryLabel") }}>
        {title}
      </Text>
    </View>
  );
}

function EmptySearchState(): React.ReactElement {
  return (
    <View style={{ alignItems: "center", paddingHorizontal: 32, paddingTop: 48 }}>
      <SymbolView name="magnifyingglass" tintColor={PlatformColor("tertiaryLabel")} size={48} />
      <Text
        style={{
          fontSize: 17,
          fontWeight: "600",
          color: PlatformColor("label"),
          marginTop: 16,
          textAlign: "center",
        }}
      >
        No Results
      </Text>
      <Text
        style={{
          fontSize: 15,
          color: PlatformColor("secondaryLabel"),
          marginTop: 8,
          textAlign: "center",
        }}
      >
        Try a different search term
      </Text>
    </View>
  );
}

function LoadingState(): React.ReactElement {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
      <Text style={{ fontSize: 15, color: PlatformColor("secondaryLabel") }}>Searching...</Text>
    </View>
  );
}

function GlassSection({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <View style={{ gap: 8 }}>
      <SectionHeader title={title} />
      <AdaptiveGlass style={{ borderRadius: 16, borderCurve: "continuous" }}>{children}</AdaptiveGlass>
    </View>
  );
}

function Separator(): React.ReactElement {
  return <View style={{ height: 1, backgroundColor: PlatformColor("separator"), marginLeft: 64 }} />;
}

function SearchResultsList({
  contacts,
  messages,
}: {
  contacts: SearchContactResult[];
  messages: SearchMessageResult[];
}): React.ReactElement {
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, gap: 16 }}
    >
      {contacts.length > 0 && (
        <GlassSection title="Contacts">
          {contacts.map((contact, index) => (
            <View key={contact._id}>
              {index > 0 && <Separator />}
              <ContactResultCard contact={contact} />
            </View>
          ))}
        </GlassSection>
      )}

      {messages.length > 0 && (
        <GlassSection title="Messages">
          {messages.map((message, index) => (
            <View key={message._id}>
              {index > 0 && <Separator />}
              <MessageResultCard message={message} />
            </View>
          ))}
        </GlassSection>
      )}
    </ScrollView>
  );
}

function DefaultContactsList(): React.ReactElement {
  const { results, status, loadMore } = usePaginatedQuery(
    api.contacts.listContactsPaginated,
    {},
    { initialNumItems: PAGE_SIZE }
  );

  const contacts: SearchContactResult[] = useMemo(
    () =>
      results
        .filter((c) => isRealContactName(c.displayName))
        .map((c) => ({
          _id: c._id,
          displayName: c.displayName,
          company: c.company ?? null,
          handles: c.handles ?? [],
        })),
    [results]
  );

  const handleEndReached = useCallback(() => {
    if (status === "CanLoadMore") {
      loadMore(PAGE_SIZE);
    }
  }, [status, loadMore]);

  const renderItem = useCallback(
    ({ item }: { item: SearchContactResult }) => <ContactResultCard contact={item} />,
    []
  );

  const renderSeparator = useCallback(() => <Separator />, []);

  const keyExtractor = useCallback((item: SearchContactResult) => item._id, []);

  if (status === "LoadingFirstPage") {
    return <LoadingState />;
  }

  return (
    <FlatList
      data={contacts}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      ItemSeparatorComponent={renderSeparator}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingVertical: 16 }}
      onEndReached={handleEndReached}
      onEndReachedThreshold={0.5}
      ListFooterComponent={
        status === "LoadingMore" ? (
          <View style={{ paddingVertical: 16, alignItems: "center" }}>
            <ActivityIndicator />
          </View>
        ) : null
      }
    />
  );
}

export default function SearchScreen(): React.ReactElement {
  const [searchQuery, setSearchQuery] = useState("");
  const { messages, contacts: searchContacts, isLoading: isSearching, hasQuery } = useSearch({
    query: searchQuery,
  });

  function handleSearchChange(event: { nativeEvent: { text: string } }): void {
    setSearchQuery(event.nativeEvent.text);
  }

  function renderContent(): React.ReactNode {
    if (!hasQuery) {
      return <DefaultContactsList />;
    }
    if (isSearching) return <LoadingState />;
    if (searchContacts.length === 0 && messages.length === 0) {
      return <EmptySearchState />;
    }
    return <SearchResultsList contacts={searchContacts} messages={messages} />;
  }

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen
        options={{
          title: "",
          headerSearchBarOptions: {
            placeholder: "Search everything...",
            onChangeText: handleSearchChange,
            autoCapitalize: "none",
          },
        }}
      />
      {renderContent()}
    </View>
  );
}
