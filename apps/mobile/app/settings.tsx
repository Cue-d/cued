import {
  Alert,
  ActivityIndicator,
  ScrollView,
  View,
  Text,
  Pressable,
  useColorScheme,
} from "react-native";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useQuery } from "convex/react";
import { SafeAreaView } from "react-native-safe-area-context";
import { Uniwind, useUniwind } from "uniwind";
import { api } from "@cued/convex";
import { getInitials, PLATFORM_CONFIG, formatRelativeTime } from "@cued/shared";
import type { ActionPlatform } from "@cued/shared";
import { getRedirectUri } from "@/lib/auth";
import { useElectronPrescence } from "@/contexts/electron-presence-context";
import { PlatformIcon } from "@/components/platform-icons";
import { ContactAvatar } from "@/components/contact-avatar";
import { cn, getDisplayName, getThemeColors } from "@/lib/utils";
import { useAuth } from "@/providers/AuthProvider";

interface SettingsRowProps {
  icon: string;
  label: string;
  value?: string;
  onPress?: () => void;
  destructive?: boolean;
}

function SettingsRow({
  icon,
  label,
  value,
  onPress,
  destructive = false,
}: SettingsRowProps): React.ReactElement {
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");

  function handlePress(): void {
    if (onPress) {
      Haptics.selectionAsync();
      onPress();
    }
  }

  const iconColor = destructive ? colors.destructive : colors.mutedForeground;

  return (
    <Pressable
      onPress={handlePress}
      disabled={!onPress}
      className="flex-row items-center gap-3 px-4 py-3 active:bg-muted"
    >
      <View className="w-7 items-center">
        <SymbolView name={icon as any} size={20} tintColor={iconColor} />
      </View>
      <Text className={cn("flex-1 text-base text-foreground", destructive && "text-destructive")}>{label}</Text>
      {value ? <Text className={cn("text-base text-muted-foreground", destructive && "text-destructive-foreground")}>{value}</Text> : null}
      {onPress && !destructive && (
        <SymbolView name="chevron.right" size={13} tintColor={colors.mutedForeground} />
      )}
    </Pressable>
  );
}

function SettingsSection({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <View className="mb-8 px-4 py-2">
      {title ? (
        <View className="px-1 mb-2">
          <Text className="text-muted-foreground text-xs">
            {title}
          </Text>
        </View>
      ) : null}
      <View className="bg-card rounded-xl overflow-hidden">{children}</View>
    </View>
  );
}

function Divider(): React.ReactElement {
  // Offset: px-4 row padding (16px) + w-7 icon (28px) + gap-3 (12px) = 56px = ml-14
  return <View className="h-px bg-border ml-14" />;
}

const SYNC_PLATFORMS: ActionPlatform[] = ["imessage", "slack", "linkedin"];

function StatusDot({ color }: { color: string }): React.ReactElement {
  return (
    <View
      className="rounded-full"
      style={{ width: 8, height: 8, backgroundColor: color }}
    />
  );
}

function IntegrationRow({
  platform,
  label,
  isConnected,
  detail,
  platformColor,
}: {
  platform: ActionPlatform;
  label: string;
  isConnected: boolean;
  detail?: string;
  platformColor: string;
}): React.ReactElement {
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");

  return (
    <View className="flex-row items-center gap-3 px-4 py-3">
      <View className="w-7 items-center">
        <PlatformIcon
          platform={platform}
          size={20}
          color={isConnected ? platformColor : colors.mutedForeground}
        />
      </View>
      <View className="flex-1">
        <Text className="text-base text-foreground">{label}</Text>
        {detail ? (
          <Text className="text-xs text-muted-foreground mt-0.5">{detail}</Text>
        ) : null}
      </View>
      <View className="flex-row items-center gap-1.5">
        <StatusDot color={isConnected ? "#16a34a" : colors.mutedForeground} />
        <Text
          className="text-sm"
          style={{ color: isConnected ? "#16a34a" : colors.mutedForeground }}
        >
          {isConnected ? "Connected" : "Not connected"}
        </Text>
      </View>
    </View>
  );
}

const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

type ThemeValue = (typeof THEME_OPTIONS)[number]["value"];

export default function SettingsScreen(): React.ReactElement {
  const { user, signOut, isLoading } = useAuth();
  const { theme, hasAdaptiveThemes } = useUniwind();
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");
  const displayName = getDisplayName(user);
  const initials = getInitials(displayName);
  const activeTheme: ThemeValue = hasAdaptiveThemes ? "system" : theme;
  const activeThemeLabel = THEME_OPTIONS.find((o) => o.value === activeTheme)?.label;

  // Sync & integrations
  const { isOnline: desktopOnline, lastSeen } = useElectronPrescence();
  const integrationsData = useQuery(api.integrations.getUserIntegrations);

  function handleSignOut(): void {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: async () => {
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          await signOut();
          router.replace("/");
        },
      },
    ]);
  }

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" />
      </View>
    );
  }

  function showComingSoon(feature: string): void {
    Alert.alert("Coming Soon", `${feature} settings will be available in a future update.`);
  }

  function handleThemeChange(): void {
    Alert.alert(
      "Appearance",
      "Choose your preferred theme",
      THEME_OPTIONS.map((option) => ({
        text: option.label + (activeTheme === option.value ? " ✓" : ""),
        onPress: () => {
          Haptics.selectionAsync();
          Uniwind.setTheme(option.value);
        },
      }))
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="pb-12">
      <View className="items-center mt-12">
        <ContactAvatar
          initials={initials}
          avatarUrl={user?.profile_picture_url}
          size={80}
          className="items-center justify-center rounded-full bg-primary"
          fallbackTextClassName="font-medium text-primary-foreground text-2xl"
        />
        <Text className="text-xl font-semibold text-foreground mt-3">{displayName}</Text>
        <Text className="text-muted-foreground text-[15px] mt-0.5">{user?.email}</Text>
      </View>

      <SettingsSection title="Account">
        <SettingsRow icon="person.circle" label="Email" value={user?.email} />
        <Divider />
        <SettingsRow
          icon="checkmark.seal"
          label="Email Verified"
          value={user?.email_verified ? "Yes" : "No"}
        />
      </SettingsSection>

      <SettingsSection title="Sync & Integrations">
        <View className="flex-row items-center gap-3 px-4 py-3">
          <View className="w-7 items-center">
            <SymbolView
              name={"desktopcomputer" as any}
              size={20}
              tintColor={desktopOnline ? colors.foreground : colors.mutedForeground}
            />
          </View>
          <View className="flex-1">
            <Text className="text-base text-foreground">Desktop App</Text>
            {!desktopOnline && lastSeen ? (
              <Text className="text-xs text-muted-foreground mt-0.5">
                Last seen {formatRelativeTime(lastSeen)}
              </Text>
            ) : null}
          </View>
          <View className="flex-row items-center gap-1.5">
            <StatusDot color={desktopOnline ? "#16a34a" : colors.mutedForeground} />
            <Text
              className="text-sm"
              style={{ color: desktopOnline ? "#16a34a" : colors.mutedForeground }}
            >
              {desktopOnline ? "Online" : "Offline"}
            </Text>
          </View>
        </View>
        {SYNC_PLATFORMS.map((platform) => {
          const integration = integrationsData?.integrations.find(
            (int) => int.platform === platform
          );
          const config = PLATFORM_CONFIG[platform];
          const isConnected = integration?.isConnected ?? false;
          const msgCount = integration?.totalMessagesSynced ?? 0;
          const detail = isConnected && msgCount > 0
            ? `${msgCount.toLocaleString()} messages synced`
            : undefined;

          return (
            <View key={platform}>
              <Divider />
              <IntegrationRow
                platform={platform}
                label={config.label}
                isConnected={isConnected}
                detail={detail}
                platformColor={config.color}
              />
            </View>
          );
        })}
      </SettingsSection>

      <SettingsSection title="App">
        <SettingsRow
          icon="bell"
          label="Notifications"
          onPress={() => showComingSoon("Notification")}
        />
        <Divider />
        <SettingsRow
          icon="paintbrush"
          label="Appearance"
          value={activeThemeLabel}
          onPress={handleThemeChange}
        />
      </SettingsSection>

      {__DEV__ && (
        <SettingsSection title="Debug">
          <SettingsRow
            icon="link"
            label="Show Redirect URI"
            onPress={() => Alert.alert("Redirect URI", getRedirectUri())}
          />
          <Divider />
          <SettingsRow
            icon="info.circle"
            label="User ID"
            value={`${user?.id?.slice(0, 8)}...`}
          />
        </SettingsSection>
      )}

      <SettingsSection>
        <SettingsRow
          icon="rectangle.portrait.and.arrow.right"
          label="Sign Out"
          onPress={handleSignOut}
          destructive
        />
      </SettingsSection>

      <Text className="text-center text-muted-foreground text-xs mt-6">Cued v1.0.0</Text>
      </ScrollView>
    </SafeAreaView>
  );
}
