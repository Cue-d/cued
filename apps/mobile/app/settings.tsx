import React from "react";
import { Alert, ActivityIndicator } from "react-native";
import { Stack, router } from "expo-router";
import { View, Text, Pressable, ScrollView } from "@/tw";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { useAuth } from "@/providers/AuthProvider";
import { getRedirectUri } from "@/lib/auth";

function Avatar({
  name,
  size = 80,
}: {
  name: string;
  size?: number;
}) {
  const initials = name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <View
      className="items-center justify-center rounded-full bg-sf-blue"
      style={{ width: size, height: size }}
    >
      <Text
        className="font-semibold text-white"
        style={{ fontSize: size * 0.4 }}
      >
        {initials}
      </Text>
    </View>
  );
}

function SettingsRow({
  icon,
  label,
  value,
  onPress,
  destructive = false,
}: {
  icon: string;
  label: string;
  value?: string;
  onPress?: () => void;
  destructive?: boolean;
}) {
  return (
    <Pressable
      onPress={() => {
        if (onPress) {
          Haptics.selectionAsync();
          onPress();
        }
      }}
      disabled={!onPress}
      className="flex-row items-center px-4 py-3 active:bg-sf-fill"
    >
      <View className="w-8 items-center">
        <SymbolView
          name={icon as any}
          size={22}
          tintColor={destructive ? "#FF3B30" : "#8E8E93"}
        />
      </View>
      <Text
        className={`flex-1 ml-3 text-base ${destructive ? "text-red-500" : "text-sf-label"}`}
      >
        {label}
      </Text>
      {value && (
        <Text className="text-sf-secondaryLabel text-base mr-2">{value}</Text>
      )}
      {onPress && !destructive && (
        <SymbolView name="chevron.right" size={14} tintColor="#C7C7CC" />
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
}) {
  return (
    <View className="mb-6">
      {title && (
        <Text className="text-sf-secondaryLabel text-xs uppercase px-4 mb-2">
          {title}
        </Text>
      )}
      <View className="bg-sf-secondaryBg rounded-xl overflow-hidden mx-4">
        {children}
      </View>
    </View>
  );
}

function Divider() {
  return <View className="h-px bg-sf-separator ml-12" />;
}

export default function SettingsScreen() {
  const { user, signOut, isLoading } = useAuth();

  const handleSignOut = () => {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: async () => {
          await Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success
          );
          await signOut();
          router.replace("/");
        },
      },
    ]);
  };

  const displayName =
    user?.firstName && user?.lastName
      ? `${user.firstName} ${user.lastName}`
      : user?.email?.split("@")[0] || "User";

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-sf-bg">
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: "Settings",
          headerLargeTitle: true,
          headerTransparent: true,
          headerBlurEffect: "systemMaterial",
        }}
      />
      <ScrollView
        className="flex-1 bg-sf-bg"
        contentContainerClassName="pt-4 pb-8"
        contentInsetAdjustmentBehavior="automatic"
      >
        {/* Profile Section */}
        <View className="items-center py-6">
          <Avatar name={displayName} size={80} />
          <Text className="text-xl font-semibold text-sf-label mt-4">
            {displayName}
          </Text>
          <Text className="text-sf-secondaryLabel mt-1">{user?.email}</Text>
        </View>

        {/* Account Section */}
        <SettingsSection title="Account">
          <SettingsRow
            icon="person.circle"
            label="Email"
            value={user?.email}
          />
          <Divider />
          <SettingsRow
            icon="checkmark.seal"
            label="Email Verified"
            value={user?.emailVerified ? "Yes" : "No"}
          />
        </SettingsSection>

        {/* App Section */}
        <SettingsSection title="App">
          <SettingsRow
            icon="bell"
            label="Notifications"
            onPress={() => Alert.alert("Coming Soon", "Notification settings will be available in a future update.")}
          />
          <Divider />
          <SettingsRow
            icon="paintbrush"
            label="Appearance"
            value="System"
            onPress={() => Alert.alert("Coming Soon", "Appearance settings will be available in a future update.")}
          />
        </SettingsSection>

        {/* Debug Section (dev only) */}
        {__DEV__ && (
          <SettingsSection title="Debug">
            <SettingsRow
              icon="link"
              label="Show Redirect URI"
              onPress={() => {
                const uri = getRedirectUri();
                Alert.alert("Redirect URI", uri);
              }}
            />
            <Divider />
            <SettingsRow
              icon="info.circle"
              label="User ID"
              value={user?.id?.slice(0, 8) + "..."}
            />
          </SettingsSection>
        )}

        {/* Sign Out */}
        <SettingsSection>
          <SettingsRow
            icon="rectangle.portrait.and.arrow.right"
            label="Sign Out"
            onPress={handleSignOut}
            destructive
          />
        </SettingsSection>

        {/* Version */}
        <Text className="text-center text-sf-tertiaryLabel text-xs mt-4">
          PRM v1.0.0
        </Text>
      </ScrollView>
    </>
  );
}
