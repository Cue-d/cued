import { useState, useCallback, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  PlatformColor,
} from "react-native";
import { Stack, Link } from "expo-router";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { BlurView } from "expo-blur";
import { SymbolView } from "expo-symbols";
import type { SFSymbols7_0 } from "sf-symbols-typescript";
import * as Haptics from "expo-haptics";
import {
  useSearch,
  type SearchContactResult,
  type SearchMessageResult,
} from "@/hooks/useSearch";

interface AdaptiveGlassProps {
  children: React.ReactNode;
  style?: object;
  isInteractive?: boolean;
}

function AdaptiveGlass({
  children,
  style,
  isInteractive = false,
}: AdaptiveGlassProps): React.ReactElement {
  if (isLiquidGlassAvailable()) {
    return (
      <GlassView isInteractive={isInteractive} style={style}>
        {children}
      </GlassView>
    );
  }

  return (
    <BlurView
      tint="systemMaterial"
      intensity={80}
      style={[style, { overflow: "hidden" }]}
    >
      {children}
    </BlurView>
  );
}

function ContactResultCard({ contact }: { contact: SearchContactResult }): React.ReactElement {
  const phoneHandle = contact.handles.find((h) => h.type === "phone");
  const emailHandle = contact.handles.find((h) => h.type === "email");
  const subtitle = contact.company || phoneHandle?.value || emailHandle?.value;

  return (
    <Link href={`/(tabs)/(contacts)/${contact._id}`} asChild>
      <Pressable
        onPressIn={() => Haptics.selectionAsync()}
        style={{
          flexDirection: "row",
          alignItems: "center",
          padding: 12,
          gap: 12,
        }}
      >
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: PlatformColor("systemGray5"),
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <SymbolView
            name="person.fill"
            tintColor={PlatformColor("secondaryLabel")}
            size={20}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text
            style={{
              fontSize: 16,
              fontWeight: "500",
              color: PlatformColor("label"),
            }}
            numberOfLines={1}
          >
            {contact.displayName}
          </Text>
          {subtitle && (
            <Text
              style={{
                fontSize: 14,
                color: PlatformColor("secondaryLabel"),
                marginTop: 2,
              }}
              numberOfLines={1}
            >
              {subtitle}
            </Text>
          )}
        </View>
        <SymbolView
          name="chevron.right"
          tintColor={PlatformColor("tertiaryLabel")}
          size={14}
        />
      </Pressable>
    </Link>
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

function MessageResultCard({ message }: { message: SearchMessageResult }): React.ReactElement {
  const platformIcon = getPlatformIcon(message.platform);

  const formattedDate = useMemo(() => {
    const date = new Date(message.sentAt);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    if (isToday) {
      return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }, [message.sentAt]);

  return (
    <Pressable
      onPressIn={() => Haptics.selectionAsync()}
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        padding: 12,
        gap: 12,
      }}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 20,
          backgroundColor: PlatformColor("systemGray5"),
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <SymbolView
          name={platformIcon}
          tintColor={PlatformColor("secondaryLabel")}
          size={20}
        />
      </View>
      <View style={{ flex: 1 }}>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <Text
            style={{
              fontSize: 16,
              fontWeight: "500",
              color: PlatformColor("label"),
              flex: 1,
            }}
            numberOfLines={1}
          >
            {message.conversationName || message.senderName || "Unknown"}
          </Text>
          <Text
            style={{
              fontSize: 13,
              color: PlatformColor("tertiaryLabel"),
              marginLeft: 8,
            }}
          >
            {formattedDate}
          </Text>
        </View>
        <Text
          style={{
            fontSize: 14,
            color: PlatformColor("secondaryLabel"),
            marginTop: 2,
          }}
          numberOfLines={2}
        >
          {message.isFromMe ? "You: " : ""}
          {message.content}
        </Text>
      </View>
    </Pressable>
  );
}

function SectionHeader({ title }: { title: string }): React.ReactElement {
  return (
    <View style={{ paddingHorizontal: 4, paddingVertical: 8 }}>
      <Text
        style={{
          fontSize: 13,
          fontWeight: "600",
          color: PlatformColor("secondaryLabel"),
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {title}
      </Text>
    </View>
  );
}

function EmptyState({ hasQuery }: { hasQuery: boolean }): React.ReactElement {
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
      }}
    >
      <SymbolView
        name={hasQuery ? "magnifyingglass" : "text.magnifyingglass"}
        tintColor={PlatformColor("tertiaryLabel")}
        size={48}
      />
      <Text
        style={{
          fontSize: 17,
          fontWeight: "600",
          color: PlatformColor("label"),
          marginTop: 16,
          textAlign: "center",
        }}
      >
        {hasQuery ? "No Results" : "Search Messages & Contacts"}
      </Text>
      <Text
        style={{
          fontSize: 15,
          color: PlatformColor("secondaryLabel"),
          marginTop: 8,
          textAlign: "center",
        }}
      >
        {hasQuery
          ? "Try a different search term"
          : "Type at least 2 characters to search"}
      </Text>
    </View>
  );
}

function LoadingState(): React.ReactElement {
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
      }}
    >
      <Text
        style={{
          fontSize: 15,
          color: PlatformColor("secondaryLabel"),
        }}
      >
        Searching...
      </Text>
    </View>
  );
}

function GlassSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <View style={{ gap: 8 }}>
      <SectionHeader title={title} />
      <AdaptiveGlass style={{ borderRadius: 16, borderCurve: "continuous" }}>
        {children}
      </AdaptiveGlass>
    </View>
  );
}

function Separator(): React.ReactElement {
  return (
    <View
      style={{
        height: 1,
        backgroundColor: PlatformColor("separator"),
        marginLeft: 64,
      }}
    />
  );
}

export default function SearchScreen(): React.ReactElement {
  const [searchQuery, setSearchQuery] = useState("");
  const { messages, contacts, isLoading, hasQuery } = useSearch({
    query: searchQuery,
  });

  const handleSearchChange = useCallback(
    (event: { nativeEvent: { text: string } }) => {
      setSearchQuery(event.nativeEvent.text);
    },
    []
  );

  const hasResults = contacts.length > 0 || messages.length > 0;

  function renderContent(): React.ReactNode {
    if (isLoading) {
      return <LoadingState />;
    }
    if (!hasResults) {
      return <EmptyState hasQuery={hasQuery} />;
    }
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

  return (
    <>
      <Stack.Screen
        options={{
          headerSearchBarOptions: {
            placeholder: "Search messages and contacts",
            onChangeText: handleSearchChange,
            autoCapitalize: "none",
          },
        }}
      />
      {renderContent()}
    </>
  );
}
