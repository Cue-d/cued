/**
 * Contact detail screen - displays full contact profile.
 *
 * Task 8.5: Create contact detail page.
 * Shows avatar, name, company, handles grouped by platform, notes, tags,
 * and recent conversations.
 */

import { useLocalSearchParams, Stack } from "expo-router";
import { useQuery } from "convex/react";
import { SymbolView } from "expo-symbols";
import type { SFSymbol } from "sf-symbols-typescript";
import { View, Text, ScrollView, Pressable } from "@/tw";
import { api } from "@prm/convex/convex/_generated/api";
import type { Id } from "@prm/convex/convex/_generated/dataModel";

/** Get initials from a name */
function getInitials(name: string): string {
  if (/^\+?\d/.test(name)) return "#";
  if (name.includes("@")) return name[0]?.toUpperCase() ?? "?";
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/** Avatar component */
function Avatar({
  initials,
  size = "large",
}: {
  initials: string;
  size?: "small" | "large";
}): React.JSX.Element {
  const sizeClasses =
    size === "large" ? "w-24 h-24 text-3xl" : "w-12 h-12 text-base";
  return (
    <View
      className={`rounded-full bg-sf-fill items-center justify-center ${sizeClasses}`}
    >
      <Text className="text-sf-label font-semibold">{initials}</Text>
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
    <View className="px-3 py-1 rounded-full bg-sf-fill mr-2 mb-2">
      <Text className="text-xs font-medium text-sf-label">{tag}</Text>
    </View>
  );
}

/** Section header component */
function SectionHeader({ title }: { title: string }): React.JSX.Element {
  return (
    <Text className="text-sm font-semibold text-sf-secondaryLabel uppercase tracking-wide mb-2 mx-4">
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
  return (
    <Pressable
      className={`flex-row items-center px-4 py-3 active:bg-sf-fill ${!isFirst ? "border-t border-sf-separator" : ""}`}
      accessibilityRole="button"
      accessibilityLabel={`${getHandleTypeLabel(handle.type)}: ${handle.value}`}
    >
      <View className="w-8 h-8 rounded-full bg-sf-fill items-center justify-center mr-3">
        <SymbolView
          name={getHandleIcon(handle.type)}
          size={14}
          tintColor="#8E8E93"
        />
      </View>
      <View className="flex-1">
        <Text className="text-xs text-sf-secondaryLabel">
          {getHandleTypeLabel(handle.type)}
        </Text>
        <Text className="text-base text-sf-label" selectable>
          {handle.value}
        </Text>
      </View>
    </Pressable>
  );
}

export default function ContactDetailScreen(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();

  const contact = useQuery(api.contacts.getContact, {
    contactId: id as Id<"contacts">,
  });

  // Loading state
  if (contact === undefined) {
    return (
      <>
        <Stack.Screen
          options={{
            headerLargeTitle: false,
            title: "Contact",
          }}
        />
        <View className="flex-1 items-center justify-center">
          <Text className="text-sf-secondaryLabel">Loading...</Text>
        </View>
      </>
    );
  }

  // Contact not found
  if (contact === null) {
    return (
      <>
        <Stack.Screen
          options={{
            headerLargeTitle: false,
            title: "Contact",
          }}
        />
        <View className="flex-1 items-center justify-center">
          <Text className="text-sf-label text-lg font-semibold">
            Contact not found
          </Text>
          <Text className="text-sf-secondaryLabel mt-2">
            This contact may have been deleted.
          </Text>
        </View>
      </>
    );
  }

  const initials = getInitials(contact.displayName);
  const groupedHandles = groupHandlesByPlatform(contact.handles ?? []);
  const platforms = Object.keys(groupedHandles);
  const hasTags = contact.tags && contact.tags.length > 0;
  const hasNotes = contact.notes && contact.notes.trim().length > 0;

  return (
    <>
      <Stack.Screen
        options={{
          headerLargeTitle: false,
          title: contact.displayName,
        }}
      />
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="pb-8"
      >
        {/* Profile Header */}
        <View className="items-center pt-6 pb-8">
          <Avatar initials={initials} size="large" />
          <Text className="text-2xl font-bold text-sf-label mt-4">
            {contact.displayName}
          </Text>
          {contact.company && (
            <Text className="text-base text-sf-secondaryLabel mt-1">
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
                  <Text className="text-sm font-medium text-sf-label">
                    {getPlatformLabel(platform)}
                  </Text>
                </View>

                {/* Handle rows */}
                <View className="mx-4 rounded-xl bg-sf-secondaryBg overflow-hidden">
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
            <View className="mx-4 p-4 rounded-xl bg-sf-secondaryBg">
              <Text className="text-base text-sf-label" selectable>
                {contact.notes}
              </Text>
            </View>
          </View>
        )}

        {/* Recent Conversations placeholder */}
        <View className="mb-6">
          <SectionHeader title="Recent Conversations" />
          <View className="mx-4 p-4 rounded-xl bg-sf-secondaryBg items-center">
            <SymbolView
              name="text.bubble"
              size={32}
              tintColor="#8E8E93"
            />
            <Text className="text-sm text-sf-secondaryLabel mt-2">
              Conversation history coming soon
            </Text>
          </View>
        </View>
      </ScrollView>
    </>
  );
}
