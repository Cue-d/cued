/**
 * ContactListItem component for contacts list.
 *
 * Task 8.1: Create ContactListItem component with preview
 * - Avatar with initials
 * - Display name and company
 * - Last message preview truncated
 * - Wrapped in Link from expo-router
 *
 * Task 8.2: Add Link.Preview and context menu
 * - Link.Trigger wrapper around content
 * - Link.Preview for peek on long press
 * - Link.Menu with Message, Call, Email, View Profile actions
 * - Destructive Block action
 */

import { Link } from "expo-router";
import * as Haptics from "expo-haptics";
import { Linking } from "react-native";
import { View, Text, Pressable } from "@/tw";
import { cn } from "@/lib/utils";

export interface ContactListItemData {
  id: string;
  displayName: string;
  company?: string | null;
  lastMessageText?: string | null;
  /** Phone number for calling/messaging - optional for context menu */
  phoneNumber?: string | null;
  /** Email address for emailing - optional for context menu */
  email?: string | null;
}

export interface ContactListItemProps {
  contact: ContactListItemData;
  className?: string;
  /** Callback when Block action is triggered from context menu */
  onBlock?: (contactId: string) => void;
}

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

/** Avatar component with initials */
function Avatar({
  initials,
  className,
}: {
  initials: string;
  className?: string;
}): React.JSX.Element {
  return (
    <View
      className={cn(
        "w-12 h-12 rounded-full bg-sf-fill items-center justify-center",
        className,
      )}
    >
      <Text className="text-sf-label font-semibold text-base">{initials}</Text>
    </View>
  );
}

/** Handle menu action with haptic feedback */
function handleMenuAction(action: () => void): void {
  Haptics.selectionAsync();
  action();
}

/**
 * ContactListItem component for contact list.
 * Displays contact avatar, name, company, and last message preview.
 * Supports peek preview on long press and context menu actions.
 */
export function ContactListItem({
  contact,
  className,
  onBlock,
}: ContactListItemProps): React.JSX.Element {
  const initials = getInitials(contact.displayName);

  const handleMessage = (): void => {
    if (contact.phoneNumber) {
      Linking.openURL(`sms:${contact.phoneNumber}`);
    }
  };

  const handleCall = (): void => {
    if (contact.phoneNumber) {
      Linking.openURL(`tel:${contact.phoneNumber}`);
    }
  };

  const handleEmail = (): void => {
    if (contact.email) {
      Linking.openURL(`mailto:${contact.email}`);
    }
  };

  const handleBlock = (): void => {
    onBlock?.(contact.id);
  };

  return (
    <Link href={`/(contacts)/${contact.id}`}>
      {/* Trigger: the tappable content */}
      <Link.Trigger>
        <Pressable
          className={cn(
            "flex-row items-center px-4 py-3 gap-3 active:bg-sf-fill",
            className,
          )}
          accessibilityRole="button"
          accessibilityLabel={`View ${contact.displayName}`}
        >
          <Avatar initials={initials} />

          <View className="flex-1 min-w-0">
            {/* Name */}
            <Text
              className="font-semibold text-base text-sf-label"
              numberOfLines={1}
            >
              {contact.displayName}
            </Text>

            {/* Company */}
            {contact.company && (
              <Text
                className="text-sm text-sf-secondaryLabel mt-0.5"
                numberOfLines={1}
              >
                {contact.company}
              </Text>
            )}

            {/* Last message preview */}
            {contact.lastMessageText && (
              <Text
                className="text-sm text-sf-tertiaryLabel mt-1"
                numberOfLines={1}
              >
                {contact.lastMessageText}
              </Text>
            )}
          </View>

          {/* Chevron indicator */}
          <Text className="text-sf-tertiaryLabel text-lg">›</Text>
        </Pressable>
      </Link.Trigger>

      {/* Preview: shown on long press (peek) */}
      <Link.Preview />

      {/* Context menu actions */}
      <Link.Menu>
        <Link.MenuAction
          title="Message"
          icon="message.fill"
          disabled={!contact.phoneNumber}
          onPress={() => handleMenuAction(handleMessage)}
        />
        <Link.MenuAction
          title="Call"
          icon="phone.fill"
          disabled={!contact.phoneNumber}
          onPress={() => handleMenuAction(handleCall)}
        />
        <Link.MenuAction
          title="Email"
          icon="envelope.fill"
          disabled={!contact.email}
          onPress={() => handleMenuAction(handleEmail)}
        />
        <Link.MenuAction
          title="View Profile"
          icon="person.crop.circle"
          onPress={() => handleMenuAction(() => {})}
        />
        <Link.MenuAction
          title="Block"
          icon="hand.raised.slash.fill"
          destructive
          onPress={() => handleMenuAction(handleBlock)}
        />
      </Link.Menu>
    </Link>
  );
}

export default ContactListItem;
