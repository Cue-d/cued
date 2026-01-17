/**
 * ContactListItem component for contacts list.
 *
 * Task 8.1: Create ContactListItem component with preview
 * - Avatar with initials
 * - Display name and company
 * - Last message preview truncated
 * - Wrapped in Link from expo-router
 */

import { Link } from "expo-router";
import { View, Text, Pressable } from "@/tw";
import { cn } from "@/lib/utils";

export interface ContactListItemData {
  id: string;
  displayName: string;
  company?: string | null;
  lastMessageText?: string | null;
}

export interface ContactListItemProps {
  contact: ContactListItemData;
  className?: string;
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

/**
 * ContactListItem component for contact list.
 * Displays contact avatar, name, company, and last message preview.
 */
export function ContactListItem({
  contact,
  className,
}: ContactListItemProps): React.JSX.Element {
  const initials = getInitials(contact.displayName);

  return (
    <Link href={`/(contacts)/${contact.id}`} asChild>
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
    </Link>
  );
}

export default ContactListItem;
