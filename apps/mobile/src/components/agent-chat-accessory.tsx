/**
 * AgentChatAccessory - Chat input rendered inside the NativeTabs.BottomAccessory.
 *
 * Regular placement: full-height input row (no extra container — the accessory
 * itself provides liquid glass).
 * Inline placement: compact "Ask anything..." label.
 */

import { View, TextInput, Pressable, Platform, Text, TouchableOpacity, useColorScheme } from "react-native";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useAgentChat } from "@/contexts/chat-context";
import { getThemeColors } from "@/lib/utils";

export function AgentChatAccessory(): React.JSX.Element {
  const placement = NativeTabs.BottomAccessory.usePlacement();
  const { input, setInput, sendMessage, isLoading } = useAgentChat();
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");

  const canSubmit = input.trim().length > 0 && !isLoading;

  function handleSubmit(): void {
    if (!canSubmit) return;
    if (Platform.OS === "ios") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    sendMessage();
  }

  if (placement === "inline") {
    return (
      <TouchableOpacity className="h-full justify-center items-center px-3">
        <Text className="text-sm font-medium text-muted-foreground">Ask anything...</Text>
      </TouchableOpacity>
    );
  }

  return (
    <View className="flex-row items-center gap-2 px-4 h-full">
      <TextInput
        className="flex-1 text-foreground leading-0 text-base"
        value={input}
        onChangeText={setInput}
        placeholder="Ask anything..."
        returnKeyType="send"
        editable={!isLoading}
        onSubmitEditing={handleSubmit}
        placeholderTextColorClassName="text-muted-foreground"
      />
      <Pressable
        onPress={canSubmit ? handleSubmit : undefined}
        hitSlop={8}
        accessibilityLabel="Send message"
        accessibilityRole="button"
        accessibilityState={{ disabled: !canSubmit }}
      >
        <SymbolView
          name="arrow.up.circle.fill"
          size={28}
          weight="medium"
          tintColor={canSubmit ? colors.primary : colors.mutedForeground}
        />
      </Pressable>
    </View>
  );
}
