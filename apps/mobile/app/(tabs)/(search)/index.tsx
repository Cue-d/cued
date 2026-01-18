import { useState, useMemo } from "react";
import { View, Text, ScrollView, Pressable, PlatformColor } from "react-native";
import { Stack, useRouter } from "expo-router";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { BlurView } from "expo-blur";
import { SymbolView } from "expo-symbols";
import type { SFSymbols7_0 } from "sf-symbols-typescript";
import * as Haptics from "expo-haptics";
import { useSearch, type SearchContactResult, type SearchMessageResult } from "@/hooks/useSearch";
import { useContacts } from "@/hooks/useContacts";

const AVATAR_SIZE = 40;

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
      style={{ flexDirection: "row", alignItems: "center", padding: 12, gap: 12 }}
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
          {subtitle && (
            <Text
              style={{ fontSize: 14, color: PlatformColor("secondaryLabel"), marginTop: 2 }}
              numberOfLines={1}
            >
              {subtitle}
            </Text>
          )}
        </View>
        <SymbolView name="chevron.right" tintColor={PlatformColor("tertiaryLabel")} size={14} />
    </Pressable>
  );
}

function getPlatformIcon(platform: string): SFSymbols7_0 {
  switch (platform) {
    case "imessage":
      return "message.fill";
    case "gmail":
      return "envelope.fill";
    default:
      return "bubble.left.fill";
  }
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
  const platformIcon = getPlatformIcon(message.platform);
  const formattedDate = useMemo(() => formatMessageDate(message.sentAt), [message.sentAt]);
  const displayName = message.conversationName || message.senderName || "Unknown";
  const messagePreview = message.isFromMe ? `You: ${message.content}` : message.content;

  return (
    <Pressable
      onPressIn={() => Haptics.selectionAsync()}
      style={{ flexDirection: "row", alignItems: "flex-start", padding: 12, gap: 12 }}
    >
      <View style={avatarStyle}>
        <SymbolView name={platformIcon} tintColor={PlatformColor("secondaryLabel")} size={20} />
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

function EmptyState({ hasQuery }: { hasQuery: boolean }): React.ReactElement {
  const icon = hasQuery ? "magnifyingglass" : "text.magnifyingglass";
  const title = hasQuery ? "No Results" : "Search Messages & Contacts";
  const subtitle = hasQuery ? "Try a different search term" : "Type at least 2 characters to search";

  return (
    <View style={{ alignItems: "center", paddingHorizontal: 32, paddingTop: 48 }}>
      <SymbolView name={icon} tintColor={PlatformColor("tertiaryLabel")} size={48} />
      <Text
        style={{
          fontSize: 17,
          fontWeight: "600",
          color: PlatformColor("label"),
          marginTop: 16,
          textAlign: "center",
        }}
      >
        {title}
      </Text>
      <Text
        style={{
          fontSize: 15,
          color: PlatformColor("secondaryLabel"),
          marginTop: 8,
          textAlign: "center",
        }}
      >
        {subtitle}
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

function ResultsList({
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

export default function SearchScreen(): React.ReactElement {
  const [searchQuery, setSearchQuery] = useState("");
  const { messages, contacts: searchContacts, isLoading: isSearching, hasQuery } = useSearch({
    query: searchQuery,
  });
  const { contacts: defaultContacts, isLoading: isLoadingContacts } = useContacts({ limit: 50 });

  const mappedDefaultContacts: SearchContactResult[] = useMemo(
    () =>
      defaultContacts.map((c) => ({
        _id: c._id,
        displayName: c.displayName,
        company: c.company ?? null,
        handles: c.handles ?? [],
      })),
    [defaultContacts]
  );

  const displayContacts = hasQuery ? searchContacts : mappedDefaultContacts;
  const isLoading = hasQuery ? isSearching : isLoadingContacts;
  const hasResults = displayContacts.length > 0 || messages.length > 0;

  function handleSearchChange(event: { nativeEvent: { text: string } }): void {
    setSearchQuery(event.nativeEvent.text);
  }

  function renderContent(): React.ReactNode {
    if (isLoading) return <LoadingState />;
    if (!hasResults && hasQuery) return <EmptyState hasQuery={hasQuery} />;
    return <ResultsList contacts={displayContacts} messages={messages} />;
  }

  return (
    <View style={{ flex: 1, backgroundColor: PlatformColor("systemGroupedBackground") }}>
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
