import React, { useState } from "react";
import { ActivityIndicator, Platform, Alert } from "react-native";
import * as Clipboard from "expo-clipboard";
import { View, Text, Pressable } from "@/tw";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { BlurView } from "expo-blur";
import { useAuth } from "@/providers/AuthProvider";
import { getRedirectUri } from "@/lib/auth";

function AdaptiveGlassCard({ children }: { children: React.ReactNode }) {
  if (isLiquidGlassAvailable()) {
    return (
      <GlassView className="mx-6 rounded-3xl overflow-hidden">
        <View className="p-8">{children}</View>
      </GlassView>
    );
  }

  if (Platform.OS === "ios") {
    return (
      <BlurView
        intensity={80}
        tint="systemMaterial"
        className="mx-6 rounded-3xl overflow-hidden"
      >
        <View className="p-8">{children}</View>
      </BlurView>
    );
  }

  return (
    <View className="mx-6 rounded-3xl overflow-hidden bg-neutral-100 dark:bg-neutral-800">
      <View className="p-8">{children}</View>
    </View>
  );
}

export default function SignInScreen() {
  const { signIn, isLoading } = useAuth();
  const [signingInWith, setSigningInWith] = useState<
    "google" | "apple" | null
  >(null);

  const handleGoogleSignIn = async () => {
    try {
      setSigningInWith("google");
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await signIn("GoogleOAuth");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(
        "Sign In Failed",
        error instanceof Error ? error.message : "An error occurred"
      );
    } finally {
      setSigningInWith(null);
    }
  };

  const handleAppleSignIn = async () => {
    try {
      setSigningInWith("apple");
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await signIn("AppleOAuth");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(
        "Sign In Failed",
        error instanceof Error ? error.message : "An error occurred"
      );
    } finally {
      setSigningInWith(null);
    }
  };

  const isSigningIn = signingInWith !== null;

  return (
    <View className="flex-1 justify-center bg-neutral-50 dark:bg-black">
      {/* Logo and Title */}
      <View className="items-center mb-12">
        <View className="w-20 h-20 rounded-2xl bg-blue-500 items-center justify-center mb-4">
          <SymbolView
            name="person.2.fill"
            size={40}
            tintColor="white"
          />
        </View>
        <Text className="text-3xl font-bold text-neutral-900 dark:text-white">
          PRM
        </Text>
        <Text className="text-base text-neutral-500 dark:text-neutral-400 mt-1">
          Personal Relationship Manager
        </Text>
      </View>

      {/* Sign In Card */}
      <AdaptiveGlassCard>
        <Text className="text-xl font-semibold text-center text-neutral-900 dark:text-white mb-6">
          Sign in to continue
        </Text>

        {/* Apple Sign In Button */}
        {Platform.OS === "ios" && (
          <Pressable
            onPress={handleAppleSignIn}
            disabled={isSigningIn}
            className="flex-row items-center justify-center bg-black dark:bg-white rounded-xl py-4 px-6 mb-3"
            style={{ minHeight: 50 }}
          >
            {signingInWith === "apple" ? (
              <ActivityIndicator color={Platform.OS === "ios" ? "white" : "black"} />
            ) : (
              <>
                <SymbolView
                  name="apple.logo"
                  size={20}
                  tintColor={Platform.OS === "ios" ? "white" : "black"}
                />
                <Text className="text-white dark:text-black font-semibold text-base ml-2">
                  Sign in with Apple
                </Text>
              </>
            )}
          </Pressable>
        )}

        {/* Google Sign In Button */}
        <Pressable
          onPress={handleGoogleSignIn}
          disabled={isSigningIn}
          className="flex-row items-center justify-center bg-white dark:bg-neutral-700 border border-neutral-200 dark:border-neutral-600 rounded-xl py-4 px-6"
          style={{ minHeight: 50 }}
        >
          {signingInWith === "google" ? (
            <ActivityIndicator color="gray" />
          ) : (
            <>
              <View className="w-5 h-5 items-center justify-center">
                <Text className="text-lg">G</Text>
              </View>
              <Text className="text-neutral-900 dark:text-white font-semibold text-base ml-2">
                Sign in with Google
              </Text>
            </>
          )}
        </Pressable>
      </AdaptiveGlassCard>

      {/* Footer */}
      <View className="mt-8 px-12">
        <Text className="text-center text-xs text-neutral-400 dark:text-neutral-500">
          By signing in, you agree to our Terms of Service and Privacy Policy
        </Text>
      </View>

      {/* Debug: Show redirect URI */}
      {__DEV__ && (
        <Pressable
          onPress={() => {
            const uri = getRedirectUri();
            Alert.alert(
              "Redirect URI",
              `Add this to WorkOS Dashboard > Redirects:\n\n${uri}`,
              [
                { text: "Copy", onPress: () => Clipboard.setStringAsync(uri) },
                { text: "OK" },
              ]
            );
          }}
          className="mt-6 px-12"
        >
          <Text className="text-center text-xs text-blue-500 underline">
            Show Redirect URI (for WorkOS setup)
          </Text>
        </Pressable>
      )}

      {/* Loading Overlay */}
      {isLoading && (
        <View className="absolute inset-0 bg-black/50 items-center justify-center">
          <ActivityIndicator size="large" color="white" />
        </View>
      )}
    </View>
  );
}
