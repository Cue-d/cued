import { Alert, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { View, Text, Pressable, ScrollView } from "@/tw";
import { useAuth } from "@/providers/AuthProvider";
import { getRedirectUri } from "@/lib/auth";
import { getDisplayName, getInitials } from "@/lib/utils";

function Avatar({ name, size = 80 }: { name: string; size?: number }): React.ReactElement {
  return (
    <View
      className="items-center justify-center rounded-full bg-sf-blue"
      style={{ width: size, height: size }}
    >
      <Text className="font-semibold text-white" style={{ fontSize: size * 0.4 }}>
        {getInitials(name)}
      </Text>
    </View>
  );
}

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
  function handlePress(): void {
    if (onPress) {
      Haptics.selectionAsync();
      onPress();
    }
  }

  const iconColor = destructive ? "#FF3B30" : "#8E8E93";
  const labelClass = destructive ? "text-red-500" : "text-sf-label";

  return (
    <Pressable
      onPress={handlePress}
      disabled={!onPress}
      className="flex-row items-center px-4 py-3 active:bg-sf-fill"
    >
      <View className="w-8 items-center">
        <SymbolView name={icon as any} size={22} tintColor={iconColor} />
      </View>
      <Text className={`flex-1 ml-3 text-base ${labelClass}`}>{label}</Text>
      {value && <Text className="text-sf-secondaryLabel text-base mr-2">{value}</Text>}
      {onPress && !destructive && <SymbolView name="chevron.right" size={14} tintColor="#C7C7CC" />}
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
    <View className="mb-6">
      {title && <Text className="text-sf-secondaryLabel text-xs uppercase px-4 mb-2">{title}</Text>}
      <View className="bg-sf-secondaryBg rounded-xl overflow-hidden mx-4">{children}</View>
    </View>
  );
}

function Divider(): React.ReactElement {
  return <View className="h-px bg-sf-separator ml-12" />;
}

export default function SettingsScreen(): React.ReactElement {
  const { user, signOut, isLoading } = useAuth();
  const displayName = getDisplayName(user);

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
      <View className="flex-1 items-center justify-center bg-sf-bg">
        <ActivityIndicator size="large" />
      </View>
    );
  }

  function showComingSoon(feature: string): void {
    Alert.alert("Coming Soon", `${feature} settings will be available in a future update.`);
  }

  return (
    <ScrollView
      className="flex-1 bg-sf-bg"
      contentContainerClassName="pt-4 pb-8"
      contentInsetAdjustmentBehavior="automatic"
    >
      <View className="items-center py-6">
        <Avatar name={displayName} size={80} />
        <Text className="text-xl font-semibold text-sf-label mt-4">{displayName}</Text>
        <Text className="text-sf-secondaryLabel mt-1">{user?.email}</Text>
      </View>

      <SettingsSection title="Account">
        <SettingsRow icon="person.circle" label="Email" value={user?.email} />
        <Divider />
        <SettingsRow
          icon="checkmark.seal"
          label="Email Verified"
          value={user?.emailVerified ? "Yes" : "No"}
        />
      </SettingsSection>

      <SettingsSection title="App">
        <SettingsRow icon="bell" label="Notifications" onPress={() => showComingSoon("Notification")} />
        <Divider />
        <SettingsRow
          icon="paintbrush"
          label="Appearance"
          value="System"
          onPress={() => showComingSoon("Appearance")}
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
          <SettingsRow icon="info.circle" label="User ID" value={`${user?.id?.slice(0, 8)}...`} />
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

      <Text className="text-center text-sf-tertiaryLabel text-xs mt-4">PRM v1.0.0</Text>
    </ScrollView>
  );
}
