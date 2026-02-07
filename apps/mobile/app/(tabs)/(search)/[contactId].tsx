/**
 * Contact detail screen - displays full contact profile.
 */

import { useState, useCallback, useMemo } from "react";
import { View, Text, ScrollView, Pressable, PlatformColor } from "react-native";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useQuery, useMutation } from "convex/react";
import { api } from "@cued/convex/convex/_generated/api";
import { getInitials, formatPhoneNumber, PLATFORM_CONFIG, type ActionPlatform } from "@cued/shared";
import { PlatformIcon } from "@/components/platform-icons";
import { SendMessageSheet, type SendMessageContact } from "@/components/send-message-sheet";
import { UndoSendToast } from "@/components/undo-send-toast";
import type { Id } from "@cued/convex/convex/_generated/dataModel";
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
    case "linkedin_handle":
      return "link";
    case "linkedin_urn":
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
    case "linkedin_handle":
      return "LinkedIn";
    case "linkedin_urn":
      return "LinkedIn URN";
    case "twitter_handle":
      return "Twitter";
    default:
      return type;
  }
}

/** Get platform label from PLATFORM_CONFIG */
function getPlatformLabel(platform: string): string {
  return PLATFORM_CONFIG[platform as ActionPlatform]?.label ?? platform;
}

/** Handle types worth displaying to the user (hide internal IDs like slack_id, linkedin_urn) */
const VISIBLE_HANDLE_TYPES = new Set(["phone", "email", "linkedin_handle", "twitter_handle"]);

/** Group handles by platform, filtering to user-visible types only */
type Handle = { type: string; value: string; platform: string };
type GroupedHandles = Record<string, Handle[]>;

function groupHandlesByPlatform(handles: Handle[]): GroupedHandles {
  return handles
    .filter((h) => VISIBLE_HANDLE_TYPES.has(h.type))
    .reduce<GroupedHandles>((acc, handle) => {
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
    <Text style={{ fontSize: 13, fontWeight: "600", color: PlatformColor("secondaryLabel"), marginBottom: 8, marginHorizontal: 16 }}>
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
  // Format phone numbers for display
  const displayValue =
    handle.type === "phone" ? formatPhoneNumber(handle.value) : handle.value;

  return (
    <Pressable
      style={!isFirst ? { borderTopWidth: 1, borderTopColor: PlatformColor("separator") } : undefined}
      className="flex-row items-center px-4 py-3 active:bg-muted"
      accessibilityRole="button"
      accessibilityLabel={`${getHandleTypeLabel(handle.type)}: ${displayValue}`}
    >
      <View
        className="w-8 h-8 rounded-full items-center justify-center mr-3"
        style={{ backgroundColor: PlatformColor("tertiarySystemFill") }}
      >
        <SymbolView name={getHandleIcon(handle.type)} size={14} tintColor={PlatformColor("secondaryLabel")} />
      </View>
      <View className="flex-1">
        <Text style={{ fontSize: 12, color: PlatformColor("secondaryLabel") }}>
          {getHandleTypeLabel(handle.type)}
        </Text>
        <Text style={{ fontSize: 16, color: PlatformColor("label"), marginTop: 2 }} selectable>
          {displayValue}
        </Text>
      </View>
    </Pressable>
  );
}

/** Platforms that support sending via the message queue */
const SENDABLE_PLATFORMS = ["imessage", "linkedin"] as const;

/** Map handle type to platform for sending */
function handleTypeToPlatform(type: string): ActionPlatform | null {
  switch (type) {
    case "phone":
      return "imessage";
    case "linkedin_handle":
      return "linkedin";
    default:
      return null;
  }
}

/** Data for a queued message toast */
interface QueuedMessageToast {
  messageId: string;
  platform: ActionPlatform;
  recipientName: string;
  messagePreview?: string;
}

export default function ContactDetailScreen(): React.JSX.Element {
  const { contactId } = useLocalSearchParams<{ contactId: string }>();

  // State for send message sheet
  const [showSendSheet, setShowSendSheet] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessageToast[]>([]);

  const contact = useQuery(api.contacts.getContact, {
    contactId: contactId as Id<"contacts">,
  });

  // Mutations for message queue
  const queueMessage = useMutation(api.messageQueue.queueMessage);
  const cancelMessage = useMutation(api.messageQueue.cancelMessage);

  // Build sendable platforms from contact handles
  const sendableContact: SendMessageContact | null = useMemo(() => {
    if (!contact) return null;

    const platforms: SendMessageContact["platforms"] = [];

    for (const handle of contact.handles ?? []) {
      const platform = handleTypeToPlatform(handle.type);
      if (platform && SENDABLE_PLATFORMS.includes(platform as typeof SENDABLE_PLATFORMS[number])) {
        // Avoid duplicates for the same platform
        if (!platforms.some((p) => p.platform === platform)) {
          platforms.push({
            platform,
            handle: handle.value,
          });
        }
      }
    }

    if (platforms.length === 0) return null;

    return {
      id: contact._id,
      name: contact.displayName,
      platforms,
    };
  }, [contact]);

  // Handle sending a message
  const handleSendMessage = useCallback(
    async (params: {
      platform: ActionPlatform;
      recipientHandle: string;
      recipientContactId?: string;
      text: string;
      conversationId?: string;
    }) => {
      const result = await queueMessage({
        platform: params.platform,
        recipientHandle: params.recipientHandle,
        recipientContactId: params.recipientContactId
          ? (params.recipientContactId as Id<"contacts">)
          : undefined,
        text: params.text,
        isGroup: false,
        conversationId: params.conversationId
          ? (params.conversationId as Id<"conversations">)
          : undefined,
      });

      // Show undo toast
      if (result?.messageId && contact) {
        setQueuedMessages((prev) => [
          ...prev,
          {
            messageId: result.messageId as string,
            platform: params.platform,
            recipientName: contact.displayName,
            messagePreview: params.text,
          },
        ]);
      }

      return result;
    },
    [queueMessage, contact]
  );

  // Handle undo for a queued message
  const handleUndoMessage = useCallback(
    async (messageId: string) => {
      await cancelMessage({ messageId: messageId as Id<"messageQueue"> });
    },
    [cancelMessage]
  );

  // Handle toast dismissal
  const handleToastDismiss = useCallback(
    (messageId: string, _reason: "sent" | "cancelled" | "closed") => {
      setQueuedMessages((prev) => prev.filter((m) => m.messageId !== messageId));
    },
    []
  );

  // Open send sheet
  const handleOpenSendSheet = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setShowSendSheet(true);
  }, []);

  // Loading state
  if (contact === undefined) {
    return (
      <View className="flex-1 bg-background">
        <Stack.Screen
          options={{
            headerLargeTitle: false,
            title: "Contact",
          }}
        />
        <View className="flex-1 items-center justify-center">
          <Text style={{ color: PlatformColor("secondaryLabel") }}>Loading...</Text>
        </View>
      </View>
    );
  }

  // Contact not found
  if (contact === null) {
    return (
      <View className="flex-1 bg-background">
        <Stack.Screen
          options={{
            headerLargeTitle: false,
            title: "Contact",
          }}
        />
        <View className="flex-1 items-center justify-center">
          <Text style={{ fontSize: 18, fontWeight: "600", color: PlatformColor("label") }}>
            Contact not found
          </Text>
          <Text style={{ color: PlatformColor("secondaryLabel"), marginTop: 8 }}>
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
    <View className="flex-1 bg-background">
      <Stack.Screen
        options={{
          title: "",
        }}
      />
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: 100 }}
      >
        {/* Profile Header */}
        <View className="items-center pb-4">
          <Avatar initials={initials} />
          <Text style={{ fontSize: 24, fontWeight: "700", color: PlatformColor("label"), marginTop: 16 }}>
            {contact.displayName}
          </Text>
          {contact.company && (
            <Text style={{ fontSize: 16, color: PlatformColor("secondaryLabel"), marginTop: 4 }}>
              {contact.company}
            </Text>
          )}

          {/* Send Message Button */}
          {sendableContact && (
            <Pressable
              onPress={handleOpenSendSheet}
              className="flex-row items-center gap-2 mt-4 px-4 py-2.5 rounded-xl bg-primary"
              accessibilityRole="button"
              accessibilityLabel="Send message"
            >
              <Text className="text-base font-medium text-primary-foreground">
                Send Message
              </Text>
            </Pressable>
          )}
        </View>

        {/* Handles grouped by platform */}
        {platforms.length > 0 && (
          <View style={{ marginBottom: 24 }}>
            {platforms.map((platform) => (
              <View key={platform} style={{ marginBottom: 16 }}>
                {/* Platform header */}
                <View style={{ flexDirection: "row", alignItems: "center", marginHorizontal: 16, marginBottom: 8 }}>
                  <PlatformIcon platform={platform as ActionPlatform} size={18} />
                  <Text style={{ fontSize: 14, fontWeight: "500", color: PlatformColor("label"), marginLeft: 8 }}>
                    {getPlatformLabel(platform)}
                  </Text>
                </View>

                {/* Handle rows */}
                <View
                  style={{
                    marginHorizontal: 16,
                    borderRadius: 12,
                    overflow: "hidden",
                    backgroundColor: PlatformColor("secondarySystemGroupedBackground"),
                  }}
                >
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
          <View style={{ marginBottom: 24 }}>
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
          <View style={{ marginBottom: 24 }}>
            <SectionHeader title="Notes" />
            <View
              style={{
                marginHorizontal: 16,
                padding: 16,
                borderRadius: 12,
                backgroundColor: PlatformColor("secondarySystemGroupedBackground"),
              }}
            >
              <Text style={{ fontSize: 16, color: PlatformColor("label") }} selectable>
                {contact.notes}
              </Text>
            </View>
          </View>
        )}

        {/* Recent Conversations placeholder */}
        <RecentConversationsPlaceholder />
      </ScrollView>

      {/* Undo send toasts for queued messages */}
      {queuedMessages.length > 0 && (
        <View
          style={{
            position: "absolute",
            bottom: 16,
            left: 0,
            right: 0,
            gap: 8,
          }}
        >
          {queuedMessages.slice(0, 3).map((msg) => (
            <UndoSendToast
              key={msg.messageId}
              messageId={msg.messageId}
              platform={msg.platform}
              recipientName={msg.recipientName}
              messagePreview={msg.messagePreview}
              onUndo={handleUndoMessage}
              onDismiss={handleToastDismiss}
            />
          ))}
        </View>
      )}

      {/* Send message sheet */}
      {sendableContact && (
        <SendMessageSheet
          visible={showSendSheet}
          onClose={() => setShowSendSheet(false)}
          contact={sendableContact}
          onSend={handleSendMessage}
        />
      )}
    </View>
  );
}

/** Recent conversations placeholder component */
function RecentConversationsPlaceholder(): React.JSX.Element {
  return (
    <View style={{ marginBottom: 24 }}>
      <SectionHeader title="Recent Conversations" />
      <View
        style={{
          marginHorizontal: 16,
          padding: 16,
          borderRadius: 12,
          backgroundColor: PlatformColor("secondarySystemGroupedBackground"),
          alignItems: "center",
        }}
      >
        <SymbolView name="text.bubble" size={32} tintColor={PlatformColor("tertiaryLabel")} />
        <Text style={{ fontSize: 14, color: PlatformColor("secondaryLabel"), marginTop: 8 }}>
          Conversation history coming soon
        </Text>
      </View>
    </View>
  );
}
