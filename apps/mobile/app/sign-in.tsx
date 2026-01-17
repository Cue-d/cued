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

type SignInProvider = "google" | "apple";

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
  const [signingInWith, setSigningInWith] = useState<SignInProvider | null>(null);

  async function handleSignIn(provider: SignInProvider) {
    const oauthProvider = provider === "google" ? "GoogleOAuth" : "AppleOAuth";
    try {
      setSigningInWith(provider);
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await signIn(oauthProvider);
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
  }

  const isSigningIn = signingInWith !== null;

  return (
    <View className="flex-1 justify-center bg-neutral-50 dark:bg-black">
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

      <AdaptiveGlassCard>
        <Text className="text-xl font-semibold text-center text-neutral-900 dark:text-white mb-6">
          Sign in to continue
        </Text>

        {Platform.OS === "ios" && (
          <Pressable
            onPress={() => handleSignIn("apple")}
            disabled={isSigningIn}
            className="flex-row items-center justify-center bg-black dark:bg-white rounded-xl py-4 px-6 mb-3"
            style={{ minHeight: 50 }}
          >
            {signingInWith === "apple" ? (
              <ActivityIndicator color="white" />
            ) : (
              <>
                <SymbolView name="apple.logo" size={20} tintColor="white" />
                <Text className="text-white dark:text-black font-semibold text-base ml-2">
                  Sign in with Apple
                </Text>
              </>
            )}
          </Pressable>
        )}

        <Pressable
          onPress={() => handleSignIn("google")}
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

      <View className="mt-8 px-12">
        <Text className="text-center text-xs text-neutral-400 dark:text-neutral-500">
          By signing in, you agree to our Terms of Service and Privacy Policy
        </Text>
      </View>

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

      {isLoading && (
        <View className="absolute inset-0 bg-black/50 items-center justify-center">
          <ActivityIndicator size="large" color="white" />
        </View>
      )}
    </View>
  );
}
