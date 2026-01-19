/**
 * ContactCard component for mobile action queue.
 *
 * Task 6.4: Create ContactCard component for new contacts with:
 * - Header with Avatar and "You met someone new" text
 * - Editable TextInput for name with User icon
 * - Editable TextInput for company with Building2 icon
 * - Editable TextInput for tags (comma-separated) with Tag icon
 * - TextInput for notes with FileText icon
 */

import { useMemo } from "react";
import { SymbolView } from "expo-symbols";
import { View, Text, ScrollView, TextInput, useColorScheme } from "react-native";
import { getInitials, PLATFORM_CONFIG, type ActionPlatform, type ContactFormData } from "@prm/shared";
import { cn, getThemeColors } from "@/lib/utils";

/** Re-export types for backwards compatibility */
export type { ContactFormData } from "@prm/shared";

/** Re-export ActionPlatform as ContactPlatform for this component */
export type ContactPlatform = ActionPlatform;

export interface ContactCardProps {
  /** Person name for header display */
  personName: string;
  /** When the contact was first seen */
  createdAt?: number;
  /** Platform where contact originated */
  platform?: ContactPlatform | null;
  /** Form data state */
  formData: ContactFormData;
  /** Called when form data changes */
  onFormChange: (data: ContactFormData) => void;
  /** Optional class name */
  className?: string;
}

/** Format timestamp to time string */
function formatMeetingTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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
        "w-10 h-10 rounded-full bg-muted items-center justify-center",
        className,
      )}
    >
      <Text className="text-foreground font-semibold text-sm">{initials}</Text>
    </View>
  );
}

/** Platform badge component */
function PlatformBadge({
  platform,
}: {
  platform: ContactPlatform;
}): React.JSX.Element {
  const config = PLATFORM_CONFIG[platform];
  return (
    <View
      className="px-2 py-0.5 rounded-md"
      style={{ backgroundColor: `${config.color}15` }}
    >
      <Text
        className="text-[10px] font-medium"
        style={{ color: config.color }}
      >
        {config.label}
      </Text>
    </View>
  );
}

/** Form field with icon and input */
function FormField({
  icon,
  label,
  value,
  onChangeText,
  placeholder,
  multiline = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  multiline?: boolean;
}): React.JSX.Element {
  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        {icon}
        <Text className="text-sm font-medium text-foreground">{label}</Text>
      </View>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColorClassName="accent-muted-foreground"
        multiline={multiline}
        className={cn(
          "bg-background rounded-xl px-3 py-3 text-foreground text-sm",
          multiline && "min-h-[100px] max-h-[200px]",
        )}
        accessibilityLabel={label}
      />
    </View>
  );
}

/** Tag badge component */
function TagBadge({ tag }: { tag: string }): React.JSX.Element {
  return (
    <View className="bg-muted px-2.5 py-1 rounded-md">
      <Text className="text-xs text-foreground">{tag}</Text>
    </View>
  );
}

/**
 * ContactCard component for action queue.
 * Displays editable contact information for new connections.
 */
export function ContactCard({
  personName,
  createdAt,
  platform,
  formData,
  onFormChange,
  className,
}: ContactCardProps): React.JSX.Element {
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");
  const initials = getInitials(personName);
  const meetingTime = createdAt ? formatMeetingTime(createdAt) : "earlier";

  // Parse tags from comma-separated string
  const tagList = useMemo(
    () =>
      formData.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    [formData.tags],
  );

  return (
    <View
      className={cn(
        "flex-1 bg-card rounded-2xl overflow-hidden",
        className,
      )}
    >
      {/* Header */}
      <View className="p-4 flex-row items-center gap-3">
        <Avatar initials={initials} />
        <View className="flex-1 min-w-0">
          <View className="flex-row items-center gap-1.5 mb-0.5">
            <SymbolView name="clock" size={12} tintColor={colors.mutedForeground} />
            <Text className="text-xs text-muted-foreground">
              You met someone new today
            </Text>
          </View>
          <View className="flex-row items-center gap-2">
            <Text
              className="font-semibold text-sm text-foreground"
              numberOfLines={1}
            >
              {personName}
            </Text>
            {platform && <PlatformBadge platform={platform} />}
          </View>
          <Text className="text-xs text-muted-foreground">
            at {meetingTime}
          </Text>
        </View>
      </View>

      {/* Form Content */}
      <ScrollView
        className="flex-1"
        contentContainerClassName="py-4 px-4 gap-5"
        keyboardShouldPersistTaps="handled"
      >
        <Text className="text-muted-foreground text-sm">
          Tell me a bit more about them so you can remember this connection
          later.
        </Text>

        {/* Name Field */}
        <FormField
          icon={<SymbolView name="person" size={16} tintColor={colors.mutedForeground} />}
          label="Name"
          value={formData.name}
          onChangeText={(text) => onFormChange({ ...formData, name: text })}
          placeholder="Their name..."
        />

        {/* Company Field */}
        <FormField
          icon={<SymbolView name="building.2" size={16} tintColor={colors.mutedForeground} />}
          label="Company"
          value={formData.company}
          onChangeText={(text) => onFormChange({ ...formData, company: text })}
          placeholder="Where do they work?"
        />

        {/* Tags Field */}
        <View className="gap-2">
          <FormField
            icon={<SymbolView name="tag" size={16} tintColor={colors.mutedForeground} />}
            label="Tags"
            value={formData.tags}
            onChangeText={(text) => onFormChange({ ...formData, tags: text })}
            placeholder="work, friend, investor, met at conference..."
          />
          {tagList.length > 0 && (
            <View className="flex-row flex-wrap gap-1.5 mt-1">
              {tagList.map((tag, i) => (
                <TagBadge key={i} tag={tag} />
              ))}
            </View>
          )}
        </View>

        {/* Notes Field */}
        <FormField
          icon={<SymbolView name="doc.text" size={16} tintColor={colors.mutedForeground} />}
          label="Notes"
          value={formData.notes}
          onChangeText={(text) => onFormChange({ ...formData, notes: text })}
          placeholder="Where did you meet? What did you talk about? Any follow-ups?"
          multiline
        />
      </ScrollView>
    </View>
  );
}

export default ContactCard;
