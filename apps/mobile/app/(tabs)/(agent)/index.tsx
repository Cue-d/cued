/**
 * Agent Tab - AI assistant chat interface
 *
 * Features:
 * - Inverted FlatList for message display
 * - SuggestedPrompts when messages are empty
 * - KeyboardAvoidingView for iOS keyboard
 * - ChatInput positioned at bottom
 */

import { useCallback, useRef } from "react";
import { FlatList, KeyboardAvoidingView, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { View, Text } from "@/tw";
import { useChat } from "@/hooks/useChat";
import {
  ChatMessage,
  type ChatMessageData,
} from "@/components/chat/chat-message";
import { ChatInput } from "@/components/chat/chat-input";
import { SuggestedPrompts } from "@/components/chat/suggested-prompts";

export default function AgentScreen() {
  const insets = useSafeAreaInsets();
  const flatListRef = useRef<FlatList<ChatMessageData>>(null);

  const { messages, input, setInput, sendMessage, isLoading, error } =
    useChat();

  const handleSendMessage = useCallback(async () => {
    await sendMessage();
  }, [sendMessage]);

  const handleSelectPrompt = useCallback(
    async (prompt: string) => {
      await sendMessage(prompt);
    },
    [sendMessage]
  );

  const renderMessage = useCallback(
    ({ item, index }: { item: ChatMessageData; index: number }) => {
      // In inverted list, index 0 is the newest message
      const isLastAssistantMessage =
        index === 0 && item.role === "assistant" && isLoading;
      return <ChatMessage message={item} isStreaming={isLastAssistantMessage} />;
    },
    [isLoading]
  );

  const keyExtractor = useCallback((item: ChatMessageData) => item.id, []);

  const showSuggestions = messages.length === 0;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      className="flex-1 bg-sf-bg"
      keyboardVerticalOffset={insets.top + 44} // Header height
    >
      <View className="flex-1">
        {showSuggestions ? (
          // Empty state with suggestions
          <View className="flex-1 justify-center">
            <View className="items-center mb-6 px-4">
              <Text className="text-sf-label text-xl font-semibold mb-2">
                PRM Assistant
              </Text>
              <Text className="text-sf-secondaryLabel text-center">
                Ask me about your contacts, messages, or relationships
              </Text>
            </View>
            <SuggestedPrompts onSelect={handleSelectPrompt} />
          </View>
        ) : (
          // Message list (inverted)
          <FlatList
            ref={flatListRef}
            data={[...messages].reverse()} // Reverse for inverted list
            renderItem={renderMessage}
            keyExtractor={keyExtractor}
            inverted
            contentContainerStyle={{
              paddingTop: 16,
              paddingBottom: 8,
            }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
          />
        )}

        {/* Error message */}
        {error && (
          <View className="px-4 py-2 bg-sf-red/10">
            <Text className="text-sf-red text-sm text-center">
              {error.message}
            </Text>
          </View>
        )}

        {/* Chat input */}
        <ChatInput
          value={input}
          onChangeText={setInput}
          onSubmit={handleSendMessage}
          disabled={isLoading}
        />
      </View>
    </KeyboardAvoidingView>
  );
}
