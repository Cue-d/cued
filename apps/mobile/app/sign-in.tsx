import { useState } from "react";
import { ActivityIndicator, Platform, Alert } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { BlurView } from "expo-blur";
import { SymbolView } from "expo-symbols";
import { View, Text, Pressable } from "@/tw";
import { useAuth } from "@/providers/AuthProvider";
import { getRedirectUri, type OAuthProvider } from "@/lib/auth";

type ButtonProvider = "google" | "apple";

function AdaptiveGlassCard({ children }: { children: React.ReactNode }): React.ReactElement {
  const content = <View className="p-8">{children}</View>;
  const containerClass = "mx-6 rounded-3xl overflow-hidden";

  if (isLiquidGlassAvailable()) {
    return <GlassView className={containerClass}>{content}</GlassView>;
  }

  if (Platform.OS === "ios") {
    return (
      <BlurView intensity={80} tint="systemMaterial" className={containerClass}>
        {content}
      </BlurView>
    );
  }

  return (
    <View className={`${containerClass} bg-neutral-100 dark:bg-neutral-800`}>{content}</View>
  );
}

interface SignInButtonProps {
  provider: ButtonProvider;
  isLoading: boolean;
  onPress: () => void;
  disabled: boolean;
}

function SignInButton({ provider, isLoading, onPress, disabled }: SignInButtonProps): React.ReactElement {
  const isApple = provider === "apple";
  const buttonClass = isApple
    ? "flex-row items-center justify-center bg-black dark:bg-white rounded-xl py-4 px-6 mb-3"
    : "flex-row items-center justify-center bg-white dark:bg-neutral-700 border border-neutral-200 dark:border-neutral-600 rounded-xl py-4 px-6";

  return (
    <Pressable onPress={onPress} disabled={disabled} className={buttonClass} style={{ minHeight: 50 }}>
      {isLoading ? (
        <ActivityIndicator color={isApple ? "white" : "gray"} />
      ) : (
        <>
          {isApple ? (
            <SymbolView name="apple.logo" size={20} tintColor="white" />
          ) : (
            <View className="w-5 h-5 items-center justify-center">
              <Text className="text-lg">G</Text>
            </View>
          )}
          <Text
            className={
              isApple
                ? "text-white dark:text-black font-semibold text-base ml-2"
                : "text-neutral-900 dark:text-white font-semibold text-base ml-2"
            }
          >
            Sign in with {isApple ? "Apple" : "Google"}
          </Text>
        </>
      )}
    </Pressable>
  );
}

export default function SignInScreen(): React.ReactElement {
  const { signIn, isLoading } = useAuth();
  const [signingInWith, setSigningInWith] = useState<ButtonProvider | null>(null);

  async function handleSignIn(provider: ButtonProvider): Promise<void> {
    const oauthProvider: OAuthProvider = provider === "google" ? "GoogleOAuth" : "AppleOAuth";
    setSigningInWith(provider);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await signIn(oauthProvider);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const message = error instanceof Error ? error.message : "An error occurred";
      Alert.alert("Sign In Failed", message);
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
          <SignInButton
            provider="apple"
            isLoading={signingInWith === "apple"}
            onPress={() => handleSignIn("apple")}
            disabled={isSigningIn}
          />
        )}

        <SignInButton
          provider="google"
          isLoading={signingInWith === "google"}
          onPress={() => handleSignIn("google")}
          disabled={isSigningIn}
        />
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
            Alert.alert("Redirect URI", `Add to WorkOS Dashboard:\n\n${uri}`, [
              { text: "Copy", onPress: () => Clipboard.setStringAsync(uri) },
              { text: "OK" },
            ]);
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
