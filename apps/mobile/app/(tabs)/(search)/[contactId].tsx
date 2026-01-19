/**
 * Contact detail screen - displays full contact profile.
 */

import { View, Text, ScrollView, Pressable, useColorScheme, PlatformColor } from "react-native";
import { useLocalSearchParams, Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useQuery } from "convex/react";
import { api } from "@prm/convex/convex/_generated/api";
import { getInitials, formatPhoneNumber } from "@prm/shared";
import type { Id } from "@prm/convex/convex/_generated/dataModel";
import type { SFSymbol } from "sf-symbols-typescript";

/** Avatar component */
function Avatar({ initials }: { initials: string }): React.JSX.Element {
  return (
    <View className="w-20 h-20 rounded-full bg-muted items-center justify-center">
      <Text className="text-[28px] font-semibold text-muted-foreground">
        {initials}
      </Text>
    </View>
  );
}

/** Handle type to SF Symbol mapping */
function getHandleIcon(type: string): SFSymbol {
  switch (type) {
    case "phone":
      return "phone.fill";
    case "email":
      return "envelope.fill";
    case "slack_id":
      return "number";
    case "linkedin_url":
      return "link";
    case "twitter_handle":
      return "at";
    default:
      return "person.fill";
  }
}

/** Handle type to display label */
function getHandleTypeLabel(type: string): string {
  switch (type) {
    case "phone":
      return "Phone";
    case "email":
      return "Email";
    case "slack_id":
      return "Slack";
    case "linkedin_url":
      return "LinkedIn";
    case "twitter_handle":
      return "Twitter";
    default:
      return type;
  }
}

/** Platform to display label */
function getPlatformLabel(platform: string): string {
  switch (platform) {
    case "imessage":
      return "iMessage";
    case "gmail":
      return "Gmail";
    case "slack":
      return "Slack";
    case "linkedin":
      return "LinkedIn";
    case "twitter":
      return "Twitter";
    default:
      return platform;
  }
}

/** Platform to tint color */
function getPlatformColor(platform: string): string {
  switch (platform) {
    case "imessage":
      return "#34C759"; // iOS green
    case "gmail":
      return "#EA4335"; // Gmail red
    case "slack":
      return "#4A154B"; // Slack purple
    case "linkedin":
      return "#0A66C2"; // LinkedIn blue
    case "twitter":
      return "#1DA1F2"; // Twitter blue
    default:
      return "#8E8E93"; // iOS gray
  }
}

/** Group handles by platform */
type Handle = { type: string; value: string; platform: string };
type GroupedHandles = Record<string, Handle[]>;

function groupHandlesByPlatform(handles: Handle[]): GroupedHandles {
  return handles.reduce<GroupedHandles>((acc, handle) => {
    const platform = handle.platform;
    if (!acc[platform]) {
      acc[platform] = [];
    }
    acc[platform].push(handle);
    return acc;
  }, {});
}

/** Tag badge component */
function TagBadge({ tag }: { tag: string }): React.JSX.Element {
  return (
    <View className="px-3 py-1.5 rounded-2xl bg-muted mr-2 mb-2">
      <Text className="text-[13px] font-medium text-foreground">{tag}</Text>
    </View>
  );
}

/** Section header component */
function SectionHeader({ title }: { title: string }): React.JSX.Element {
  return (
    <Text className="text-[13px] font-semibold text-muted-foreground mb-2 mx-4">
      {title}
    </Text>
  );
}

/** Handle row component */
function HandleRow({
  handle,
  isFirst,
}: {
  handle: Handle;
  isFirst: boolean;
}): React.JSX.Element {
  const colorScheme = useColorScheme();
  const iconColor = colorScheme === "dark" ? "#a1a1aa" : "#71717a";

  // Format phone numbers for display
  const displayValue =
    handle.type === "phone" ? formatPhoneNumber(handle.value) : handle.value;

  return (
    <Pressable
      className={`flex-row items-center px-4 py-3 active:bg-muted ${!isFirst ? "border-t border-border" : ""}`}
      accessibilityRole="button"
      accessibilityLabel={`${getHandleTypeLabel(handle.type)}: ${displayValue}`}
    >
      <View className="w-8 h-8 rounded-full bg-muted items-center justify-center mr-3">
        <SymbolView name={getHandleIcon(handle.type)} size={14} tintColor={iconColor} />
      </View>
      <View className="flex-1">
        <Text className="text-xs text-muted-foreground">
          {getHandleTypeLabel(handle.type)}
        </Text>
        <Text className="text-base text-foreground mt-0.5" selectable>
          {displayValue}
        </Text>
      </View>
    </Pressable>
  );
}

export default function ContactDetailScreen(): React.JSX.Element {
  const { contactId } = useLocalSearchParams<{ contactId: string }>();

  const contact = useQuery(api.contacts.getContact, {
    contactId: contactId as Id<"contacts">,
  });

  // Loading state
  if (contact === undefined) {
    return (
      <View style={{ flex: 1, backgroundColor: PlatformColor("systemGroupedBackground") }}>
        <Stack.Screen
          options={{
            headerLargeTitle: false,
            title: "Contact",
          }}
        />
        <View className="flex-1 items-center justify-center">
          <Text className="text-muted-foreground">Loading...</Text>
        </View>
      </View>
    );
  }

  // Contact not found
  if (contact === null) {
    return (
      <View style={{ flex: 1, backgroundColor: PlatformColor("systemGroupedBackground") }}>
        <Stack.Screen
          options={{
            headerLargeTitle: false,
            title: "Contact",
          }}
        />
        <View className="flex-1 items-center justify-center">
          <Text className="text-lg font-semibold text-foreground">
            Contact not found
          </Text>
          <Text className="text-muted-foreground mt-2">
            This contact may have been deleted.
          </Text>
        </View>
      </View>
    );
  }

  const initials = getInitials(contact.displayName);
  const groupedHandles = groupHandlesByPlatform(contact.handles ?? []);
  const platforms = Object.keys(groupedHandles);
  const hasTags = contact.tags && contact.tags.length > 0;
  const hasNotes = contact.notes && contact.notes.trim().length > 0;

  return (
    <View style={{ flex: 1, backgroundColor: PlatformColor("systemGroupedBackground") }}>
      <Stack.Screen
        options={{
          headerLargeTitle: false,
          title: contact.displayName,
        }}
      />
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: 32 }}
      >
        {/* Profile Header */}
        <View className="items-center pt-6 pb-8">
          <Avatar initials={initials} />
          <Text className="text-2xl font-bold text-foreground mt-4">
            {contact.displayName}
          </Text>
          {contact.company && (
            <Text className="text-base text-muted-foreground mt-1">
              {contact.company}
            </Text>
          )}
        </View>

        {/* Handles grouped by platform */}
        {platforms.length > 0 && (
          <View className="mb-6">
            {platforms.map((platform) => (
              <View key={platform} className="mb-4">
                {/* Platform header */}
                <View className="flex-row items-center mx-4 mb-2">
                  <View
                    className="w-6 h-6 rounded-md items-center justify-center mr-2"
                    style={{ backgroundColor: `${getPlatformColor(platform)}20` }}
                  >
                    <SymbolView
                      name="circle.fill"
                      size={8}
                      tintColor={getPlatformColor(platform)}
                    />
                  </View>
                  <Text className="text-sm font-medium text-foreground">
                    {getPlatformLabel(platform)}
                  </Text>
                </View>

                {/* Handle rows */}
                <View className="mx-4 rounded-xl bg-card overflow-hidden">
                  {groupedHandles[platform].map((handle, idx) => (
                    <HandleRow
                      key={`${handle.type}-${handle.value}`}
                      handle={handle}
                      isFirst={idx === 0}
                    />
                  ))}
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Tags */}
        {hasTags && (
          <View className="mb-6">
            <SectionHeader title="Tags" />
            <View className="flex-row flex-wrap mx-4">
              {contact.tags!.map((tag) => (
                <TagBadge key={tag} tag={tag} />
              ))}
            </View>
          </View>
        )}

        {/* Notes */}
        {hasNotes && (
          <View className="mb-6">
            <SectionHeader title="Notes" />
            <View className="mx-4 p-4 rounded-xl bg-card">
              <Text className="text-base text-foreground" selectable>
                {contact.notes}
              </Text>
            </View>
          </View>
        )}

        {/* Recent Conversations placeholder */}
        <RecentConversationsPlaceholder />
      </ScrollView>
    </View>
  );
}

/** Recent conversations placeholder component */
function RecentConversationsPlaceholder(): React.JSX.Element {
  const colorScheme = useColorScheme();
  const iconColor = colorScheme === "dark" ? "#6b7280" : "#9ca3af";

  return (
    <View className="mb-6">
      <SectionHeader title="Recent Conversations" />
      <View className="mx-4 p-4 rounded-xl bg-card items-center">
        <SymbolView name="text.bubble" size={32} tintColor={iconColor} />
        <Text className="text-sm text-muted-foreground mt-2">
          Conversation history coming soon
        </Text>
      </View>
    </View>
  );
}
