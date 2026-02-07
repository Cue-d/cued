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
import { View, Text, ScrollView, TextInput, Pressable, useColorScheme } from "react-native";
import { SymbolView } from "expo-symbols";
import { type ActionPlatform, type ContactFormData } from "@cued/shared";
import { PlatformIcon } from "@/components/platform-icons";
import { cn, getThemeColors } from "@/lib/utils";

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
  /** Called when the platform icon is pressed to open in app */
  onOpenInApp?: (() => void) | null;
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
  onOpenInApp,
}: ContactCardProps): React.JSX.Element {
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");

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
        "flex-1 overflow-hidden",
        className,
      )}
    >
      {/* Header - centered name, platform top-right */}
      <View className="px-4 pt-4 pb-2">
        <View className="flex-row items-center justify-center relative">
          <Text
            className="font-semibold text-base text-foreground text-center"
            numberOfLines={1}
          >
            {personName}
          </Text>
          {platform && (
            <Pressable
              className={cn(
                "absolute right-0 flex-row items-center gap-1.5 rounded-lg px-2.5 py-1.5",
                onOpenInApp ? "bg-muted active:opacity-70" : "bg-muted/40 opacity-50",
              )}
              onPress={onOpenInApp ?? undefined}
              disabled={!onOpenInApp}
              accessibilityLabel={onOpenInApp ? `Open in ${platform}` : platform}
              accessibilityRole={onOpenInApp ? "button" : undefined}
            >
              <PlatformIcon platform={platform} size={12} />
              <Text className="text-xs font-medium text-foreground">Open</Text>
            </Pressable>
          )}
        </View>
        <Text className="text-xs text-muted-foreground text-center mt-1">
          New connection
        </Text>
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
