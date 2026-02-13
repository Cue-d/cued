/**
 * ResolveContactCard component for mobile action queue.
 *
 * Shows two contacts vertically stacked for merge review.
 * Adapted from Electron's side-by-side layout to vertical for mobile.
 */

import { useState } from "react";
import { View, Text, Pressable, useColorScheme } from "react-native";
import * as Haptics from "expo-haptics";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { getInitials, PLATFORM_CONFIG, type ContactHandle, type ActionPlatform } from "@cued/shared";
import { PlatformIcon } from "@/components/platform-icons";
import { cn, getThemeColors } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────

export type MergeSource =
  | "email_match"
  | "phone_match"
  | "exact_name_match"
  | "fuzzy_name_match"
  | "llm_fuzzy_match"
  | "linkedin_urn_match";

export interface ContactInfo {
  name: string;
  company?: string | null;
  handles: ContactHandle[];
}

export interface ResolveContactCardProps {
  contact1: ContactInfo;
  contact2: ContactInfo;
  confidence: number;
  source: MergeSource;
  reasoning?: string | null;
  className?: string;
  /** Called when the "Open" button is pressed for contact 1 */
  onOpenContact1?: (() => void) | null;
  /** Called when the "Open" button is pressed for contact 2 */
  onOpenContact2?: (() => void) | null;
  /** Platform for contact 1's open button */
  contact1Platform?: string | null;
  /** Platform for contact 2's open button */
  contact2Platform?: string | null;
}

// ── Source Badge ───────────────────────────────────────────────────

const SOURCE_COLORS: Record<MergeSource, { bg: string; text: string }> = {
  email_match: { bg: "bg-red-500/10", text: "text-red-600" },
  phone_match: { bg: "bg-green-500/10", text: "text-green-600" },
  exact_name_match: { bg: "bg-blue-500/10", text: "text-blue-600" },
  fuzzy_name_match: { bg: "bg-amber-500/10", text: "text-amber-600" },
  llm_fuzzy_match: { bg: "bg-purple-500/10", text: "text-purple-600" },
  linkedin_urn_match: { bg: "bg-blue-500/10", text: "text-blue-600" },
};

function formatSource(source: MergeSource): string {
  return source.replace(/_/g, " ");
}

function SourceBadge({ source }: { source: MergeSource }): React.JSX.Element {
  const colors = SOURCE_COLORS[source] ?? SOURCE_COLORS.email_match;
  return (
    <View className={cn("px-2 py-0.5 rounded-full", colors.bg)}>
      <Text className={cn("text-xs capitalize", colors.text)}>
        {formatSource(source)}
      </Text>
    </View>
  );
}

// ── Handle Row ────────────────────────────────────────────────────

type SFSymbolName = SymbolViewProps["name"];

const HANDLE_ICON_MAP: Record<string, SFSymbolName> = {
  phone: "phone",
  email: "envelope",
  slack_id: "bubble.left",
  linkedin_handle: "link",
  linkedin_urn: "link",
  twitter_handle: "at",
};

const PLATFORM_BADGE_COLORS: Record<string, { bg: string; text: string }> = {
  imessage: { bg: "bg-green-500/10", text: "text-green-600" },
  slack: { bg: "bg-purple-500/10", text: "text-purple-600" },
  linkedin: { bg: "bg-blue-500/10", text: "text-blue-600" },
  twitter: { bg: "bg-sky-500/10", text: "text-sky-600" },
};

function HandleRow({
  handle,
  iconColor,
}: {
  handle: ContactHandle;
  iconColor: string;
}): React.JSX.Element {
  const symbolName = HANDLE_ICON_MAP[handle.type] ?? "questionmark";
  const badge = PLATFORM_BADGE_COLORS[handle.platform.toLowerCase()];
  return (
    <View className="flex-row items-center gap-2 py-0.5">
      <SymbolView name={symbolName} size={12} tintColor={iconColor} />
      <Text className="text-xs text-foreground flex-1" numberOfLines={1}>
        {handle.value}
      </Text>
      {badge && (
        <View className={cn("px-1.5 py-0.5 rounded", badge.bg)}>
          <Text className={cn("text-[10px]", badge.text)}>
            {handle.platform}
          </Text>
        </View>
      )}
    </View>
  );
}

// ── Open In App Button ────────────────────────────────────────────

function OpenInAppButton({
  onPress,
  platform,
}: {
  onPress: () => void;
  platform: string;
}): React.JSX.Element {
  const config = PLATFORM_CONFIG[platform as ActionPlatform];
  const label = config ? `Open ${config.label}` : "Open";
  return (
    <Pressable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      className="flex-row items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-muted active:opacity-70"
      accessibilityLabel={label}
      accessibilityRole="button"
    >
      <PlatformIcon platform={platform as ActionPlatform} size={12} />
      <Text className="text-xs font-medium text-foreground">{label}</Text>
      <SymbolView name="arrow.up.forward" size={10} tintColor="#71717A" />
    </Pressable>
  );
}

// ── Contact Panel ─────────────────────────────────────────────────

function ContactPanel({
  contact,
  iconColor,
  onOpen,
  openPlatform,
}: {
  contact: ContactInfo;
  iconColor: string;
  onOpen?: (() => void) | null;
  openPlatform?: string | null;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const initials = getInitials(contact.name);
  const visibleHandles = expanded
    ? contact.handles
    : contact.handles.slice(0, 2);
  const hasMore = contact.handles.length > 2;

  return (
    <View className="gap-2">
      {/* Avatar + Name + Company */}
      <View className="flex-row items-center gap-3">
        <View className="size-8 rounded-full bg-muted items-center justify-center">
          <Text className="text-sm font-semibold text-muted-foreground">
            {initials}
          </Text>
        </View>
        <View className="flex-1 min-w-0">
          <Text
            className="font-semibold text-sm text-foreground"
            numberOfLines={1}
          >
            {contact.name}
          </Text>
          {contact.company ? (
            <Text
              className="text-xs text-muted-foreground"
              numberOfLines={1}
            >
              {contact.company}
            </Text>
          ) : null}
        </View>
      </View>

      {/* Handles */}
      {visibleHandles.length > 0 && (
        <View className="gap-0.5 ml-[52px]">
          {visibleHandles.map((handle, i) => (
            <HandleRow
              key={`${handle.type}-${handle.value}-${i}`}
              handle={handle}
              iconColor={iconColor}
            />
          ))}
        </View>
      )}

      {/* Expand / collapse */}
      {hasMore && (
        <Pressable
          onPress={() => setExpanded(!expanded)}
          className="ml-[52px] py-1"
        >
          <Text className="text-xs text-muted-foreground">
            {expanded ? "Show less" : `${contact.handles.length - 2} more…`}
          </Text>
        </Pressable>
      )}

      {/* Open in app button */}
      {onOpen && openPlatform ? (
        <View className="ml-[44px] mt-1">
          <OpenInAppButton onPress={onOpen} platform={openPlatform} />
        </View>
      ) : null}
    </View>
  );
}

// ── Main Card ─────────────────────────────────────────────────────

export function ResolveContactCard({
  contact1,
  contact2,
  source,
  reasoning,
  className,
  onOpenContact1,
  onOpenContact2,
  contact1Platform,
  contact2Platform,
}: ResolveContactCardProps): React.JSX.Element {
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");

  return (
    <View className={cn("flex-1 overflow-hidden", className)}>
      {/* Header */}
      <View className="px-6 pt-6 gap-2">
        <View className="flex-row items-center justify-between">
          <View className="flex-row w-full items-center justify-between gap-2">
            <Text className="text-sm font-medium text-foreground">
              Update contact
            </Text>
            <SourceBadge source={source} />
          </View>
        </View>
        {reasoning ? (
          <Text
            className="text-xs text-muted-foreground"
            numberOfLines={2}
          >
            Are accounts the same person?</Text>
        ) : null}
      </View>

      {/* Contact panels - vertically stacked */}
      <View className="flex-1 px-6 justify-center gap-0">
        {/* Contact 1 */}
        <ContactPanel
          contact={contact1}
          iconColor={colors.mutedForeground}
          onOpen={onOpenContact1}
          openPlatform={contact1Platform}
        />

        {/* Divider with icon */}
        <View className="flex-row items-center gap-3 py-3">
          <View className="flex-1 h-px bg-border" />
          <SymbolView
            name="arrow.up.arrow.down"
            size={14}
            tintColor={colors.mutedForeground}
          />
          <View className="flex-1 h-px bg-border" />
        </View>

        {/* Contact 2 */}
        <ContactPanel
          contact={contact2}
          iconColor={colors.mutedForeground}
          onOpen={onOpenContact2}
          openPlatform={contact2Platform}
        />
      </View>
    </View>
  );
}

export default ResolveContactCard;
