import { useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Alert,
  View,
  Text,
  Pressable,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import Animated, { FadeIn, FadeInUp } from "react-native-reanimated";
import { getRedirectUri, type OAuthProvider } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { useAuth } from "@/providers/AuthProvider";

type ButtonProvider = "google" | "apple";

interface SignInButtonProps {
  provider: ButtonProvider;
  isLoading: boolean;
  onPress: () => void;
  disabled: boolean;
  delay?: number;
}

function getIndicatorStyle(useLiquidGlass: boolean, isApple: boolean): string {
  if (useLiquidGlass) return "text-foreground";
  if (isApple) return "text-white";
  return "text-muted-foreground";
}

function getGoogleIconStyle(useLiquidGlass: boolean): string {
  return useLiquidGlass ? "text-foreground" : "text-[#4285F4]";
}

function getLabelStyle(useLiquidGlass: boolean, isApple: boolean): string {
  if (useLiquidGlass) return "text-foreground";
  if (isApple) return "text-white";
  return "text-foreground";
}

function SignInButton({
  provider,
  isLoading,
  onPress,
  disabled,
  delay = 0,
}: SignInButtonProps): React.ReactElement {
  const isApple = provider === "apple";
  const useLiquidGlass = isLiquidGlassAvailable();
  const enterAnimation = FadeInUp.delay(delay).duration(400).springify();

  const buttonContent = (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className="flex-row items-center justify-center py-4 px-6 min-h-14"
      style={{ opacity: disabled && !isLoading ? 0.6 : 1 }}
    >
      {isLoading ? (
        <ActivityIndicator
          className={getIndicatorStyle(useLiquidGlass, isApple)}
        />
      ) : (
        <>
          {isApple ? (
            <SymbolView name="apple.logo" size={22} tintColor="white" />
          ) : (
            <View className="w-[22px] h-[22px] items-center justify-center">
              <Text
                className={cn(
                  "text-lg font-semibold",
                  getGoogleIconStyle(useLiquidGlass),
                )}
              >
                G
              </Text>
            </View>
          )}
          <Text
            className={cn(
              "font-semibold text-[17px] ml-2.5",
              getLabelStyle(useLiquidGlass, isApple),
            )}
          >
            Continue with {isApple ? "Apple" : "Google"}
          </Text>
        </>
      )}
    </Pressable>
  );

  if (useLiquidGlass) {
    return (
      <Animated.View entering={enterAnimation} style={{ marginBottom: 12 }}>
        <GlassView
          isInteractive
          style={{ borderRadius: 16, overflow: "hidden" }}
        >
          {buttonContent}
        </GlassView>
      </Animated.View>
    );
  }

  return (
    <Animated.View entering={enterAnimation}>
      <View
        className={cn(
          "rounded-2xl mb-3 overflow-hidden",
          isApple ? "bg-black" : "bg-secondary",
        )}
        style={{ borderCurve: "continuous" }}
      >
        {buttonContent}
      </View>
    </Animated.View>
  );
}

function showRedirectUri(): void {
  const uri = getRedirectUri();
  Alert.alert("Redirect URI", `Add to WorkOS Dashboard:\n\n${uri}`, [
    { text: "Copy", onPress: () => Clipboard.setStringAsync(uri) },
    { text: "OK" },
  ]);
}

export default function SignInScreen(): React.ReactElement {
  const { signIn, isLoading } = useAuth();
  const [signingInWith, setSigningInWith] = useState<ButtonProvider | null>(
    null,
  );
  const isSigningIn = signingInWith !== null;

  async function handleSignIn(provider: ButtonProvider): Promise<void> {
    const oauthProvider: OAuthProvider =
      provider === "google" ? "GoogleOAuth" : "AppleOAuth";
    setSigningInWith(provider);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await signIn(oauthProvider);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const message =
        error instanceof Error ? error.message : "An error occurred";
      Alert.alert("Sign In Failed", message);
    } finally {
      setSigningInWith(null);
    }
  }

  return (
    <View className="flex-1 bg-background">
      <View className="flex-1 justify-center px-6">
        <Animated.View
          entering={FadeIn.duration(600)}
          className="items-center mb-12"
        >
          <View
            className="w-[88px] h-[88px] rounded-[22px] bg-primary items-center justify-center mb-5"
            style={{
              borderCurve: "continuous",
              boxShadow: "0 8px 24px rgba(0, 0, 0, 0.15)",
            }}
          >
            <SymbolView name="person.2.fill" size={44} tintColor="white" />
          </View>
          <Text className="text-4xl font-bold text-foreground tracking-tight">
            Cued
          </Text>
        </Animated.View>

        <View>
          {Platform.OS === "ios" && (
            <SignInButton
              provider="apple"
              isLoading={signingInWith === "apple"}
              onPress={() => handleSignIn("apple")}
              disabled={isSigningIn}
              delay={200}
            />
          )}
          <SignInButton
            provider="google"
            isLoading={signingInWith === "google"}
            onPress={() => handleSignIn("google")}
            disabled={isSigningIn}
            delay={Platform.OS === "ios" ? 280 : 200}
          />
        </View>

        <Animated.View
          entering={FadeInUp.delay(400).duration(400)}
          className="mt-8 px-4"
        >
          <Text className="text-center text-[13px] text-muted-foreground leading-[18px]">
            By signing in, you agree to our Terms of Service and Privacy Policy
          </Text>
        </Animated.View>

        {__DEV__ && (
          <Animated.View entering={FadeInUp.delay(500).duration(400)}>
            <Pressable onPress={showRedirectUri} className="mt-6 px-4">
              <Text className="text-center text-[13px] text-primary">
                Show Redirect URI (for WorkOS setup)
              </Text>
            </Pressable>
          </Animated.View>
        )}
      </View>

      {isLoading && (
        <View className="absolute inset-0 bg-black/50 items-center justify-center">
          <ActivityIndicator size="large" color="white" />
        </View>
      )}
    </View>
  );
}
