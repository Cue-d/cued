import React from "react";
import { router } from "expo-router";
import { Pressable, View, Text } from "@/tw";
import * as Haptics from "expo-haptics";
import { useAuth } from "@/providers/AuthProvider";

interface HeaderAvatarProps {
  size?: number;
}

export function HeaderAvatar({ size = 32 }: HeaderAvatarProps) {
  const { user } = useAuth();

  const displayName =
    user?.firstName && user?.lastName
      ? `${user.firstName} ${user.lastName}`
      : user?.email?.split("@")[0] || "U";

  const initials = displayName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  const handlePress = () => {
    Haptics.selectionAsync();
    router.push("/settings");
  };

  return (
    <Pressable
      onPress={handlePress}
      className="active:opacity-70"
      accessibilityLabel="Open settings"
      accessibilityRole="button"
    >
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
    </Pressable>
  );
}
