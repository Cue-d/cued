/**
 * Agent Tab - AI assistant chat interface
 *
 * Features:
 * - Keyboard-friendly ScrollView for message display
 * - SuggestedPrompts when messages are empty
 * - Animated keyboard handling
 * - ChatInput positioned at bottom
 *
 * Based on expo-ai chat UI design
 */

import { useCallback, useRef } from "react";
import { Platform } from "react-native";
import Animated, {
  KeyboardState,
  scrollTo,
  useAnimatedKeyboard,
  useAnimatedRef,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { View, Text } from "react-native";
import { useChat } from "@/hooks/useChat";
import { ChatMessage } from "@/components/chat/chat-message";
import { ChatInput } from "@/components/chat/chat-input";
import { SuggestedPrompts } from "@/components/chat/suggested-prompts";
import { ErrorBoundary } from "@/components/error-boundary";

/**
 * Keyboard-friendly ScrollView that auto-scrolls to bottom
 * and handles keyboard appearance smoothly
 */
function KeyboardFriendlyScrollView({
  children,
  onContentSizeChange,
}: {
  children: React.ReactNode;
  onContentSizeChange?: () => void;
}) {
  const ref = useAnimatedRef<Animated.ScrollView>();
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboard = useAnimatedKeyboard({});
  const { bottom } = useSafeAreaInsets();
  const scrollOffset = useSharedValue(0);
  const lastKeyboardState = useSharedValue(KeyboardState.UNKNOWN);
  const keyboardHeight = useSharedValue(0);
  const scrollOffsetAtStart = useSharedValue(0);
  const isTouching = useSharedValue(false);
  const isScrollViewControlled = useSharedValue(false);

  useDerivedValue(() => {
    if (keyboard.state.value === KeyboardState.OPEN) {
      keyboardHeight.value = keyboard.height.value;
    }
  });

  const scrollToBottom = useCallback(() => {
    timeout.current && clearTimeout(timeout.current);
    timeout.current = setTimeout(() => {
      ref.current?.scrollToEnd({ animated: true });
    }, 15);
  }, [ref]);

  const scrollToBottomIfNotPanning = useCallback(() => {
    if (
      keyboard.state.value === KeyboardState.OPENING ||
      keyboard.state.value === KeyboardState.CLOSING ||
      isScrollViewControlled.value
    ) {
      return;
    }
    scrollToBottom();
    onContentSizeChange?.();
  }, [keyboard, isScrollViewControlled, scrollToBottom, onContentSizeChange]);

  useDerivedValue(() => {
    if (
      !isScrollViewControlled.value &&
      keyboard.state.value === KeyboardState.CLOSING &&
      lastKeyboardState.value === KeyboardState.OPEN &&
      isTouching.value
    ) {
      isScrollViewControlled.value = true;
    }

    if (
      keyboard.state.value === KeyboardState.OPEN ||
      keyboard.state.value === KeyboardState.CLOSED
    ) {
      if (
        !isScrollViewControlled.value &&
        lastKeyboardState.value !== keyboard.state.value &&
        keyboard.state.value === KeyboardState.OPEN
      ) {
        scrollTo(ref, 0, Number.MAX_SAFE_INTEGER, true);
      }

      isScrollViewControlled.value = false;
    }

    if (lastKeyboardState.value !== keyboard.state.value) {
      lastKeyboardState.value = keyboard.state.value;
      scrollOffsetAtStart.value = scrollOffset.value;
    }
  });

  useDerivedValue(() => {
    if (isScrollViewControlled.value) {
      return;
    }

    if (keyboard.state.value === KeyboardState.OPENING) {
      scrollTo(
        ref,
        0,
        scrollOffsetAtStart.value + Math.max(0, keyboard.height.value - bottom),
        false
      );
    } else if (keyboard.state.value === KeyboardState.CLOSING) {
      scrollTo(
        ref,
        0,
        scrollOffsetAtStart.value -
          Math.max(0, keyboardHeight.value - keyboard.height.value - bottom),
        false
      );
    }
  });

  const keyboardBlurUnderlayStyle = useAnimatedStyle(() => {
    const height = Math.max(keyboard.height.value, bottom);
    return {
      height,
    };
  }, [bottom]);

  return (
    <Animated.ScrollView
      ref={ref}
      onTouchStart={() => {
        isTouching.value = true;
      }}
      onTouchMove={() => {
        isTouching.value = true;
      }}
      onTouchEnd={() => {
        isTouching.value = false;
      }}
      onTouchCancel={() => {
        isTouching.value = false;
      }}
      onScroll={(e) => {
        scrollOffset.value = e.nativeEvent.contentOffset.y;
      }}
      onContentSizeChange={scrollToBottomIfNotPanning}
      onLayout={scrollToBottomIfNotPanning}
      scrollEventThrottle={16}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      contentContainerStyle={{ paddingTop: 16, paddingBottom: 8 }}
    >
      {children}
      {Platform.OS !== "web" && (
        <Animated.View style={keyboardBlurUnderlayStyle} />
      )}
    </Animated.ScrollView>
  );
}

export default function AgentScreen() {
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

  const showSuggestions = messages.length === 0;

  return (
    <ErrorBoundary>
      <View className="flex-1">
        {showSuggestions ? (
          // Empty state with suggestions
          <View className="flex-1 justify-center">
            <View className="items-center mb-8 px-4">
              <Text className="text-sf-label text-2xl font-semibold mb-2">
                PRM Assistant
              </Text>
              <Text className="text-sf-secondaryLabel text-center text-[16px]">
                Ask me about your contacts, messages, or relationships
              </Text>
            </View>
            <SuggestedPrompts onSelect={handleSelectPrompt} />
          </View>
        ) : (
          // Message list with keyboard handling
          <KeyboardFriendlyScrollView>
            {messages.map((message, index) => {
              const isLastAssistantMessage =
                index === messages.length - 1 &&
                message.role === "assistant" &&
                isLoading;
              return (
                <ChatMessage
                  key={message.id}
                  message={message}
                  isStreaming={isLastAssistantMessage}
                />
              );
            })}
          </KeyboardFriendlyScrollView>
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
    </ErrorBoundary>
  );
}
