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
import { Platform , View, Text } from "react-native";
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
import { ChatInput } from "@/components/chat/chat-input";
import { ChatMessage } from "@/components/chat/chat-message";
import { SuggestedPrompts } from "@/components/chat/suggested-prompts";
import { ErrorBoundary } from "@/components/error-boundary";
import { useChat } from "@/hooks/useChat";
import { getAccessToken } from "@/lib/auth";

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
  const { top, bottom } = useSafeAreaInsets();
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
    const currentState = keyboard.state.value;
    const stateChanged = lastKeyboardState.value !== currentState;
    const isClosing = currentState === KeyboardState.CLOSING;
    const isOpen = currentState === KeyboardState.OPEN;
    const isClosed = currentState === KeyboardState.CLOSED;
    const wasOpen = lastKeyboardState.value === KeyboardState.OPEN;

    // Take control when user is touching while keyboard closes
    if (!isScrollViewControlled.value && isClosing && wasOpen && isTouching.value) {
      isScrollViewControlled.value = true;
    }

    // Handle keyboard fully open or closed states
    if (isOpen || isClosed) {
      if (!isScrollViewControlled.value && stateChanged && isOpen) {
        scrollTo(ref, 0, Number.MAX_SAFE_INTEGER, true);
      }
      isScrollViewControlled.value = false;
    }

    // Track state changes
    if (stateChanged) {
      lastKeyboardState.value = currentState;
      scrollOffsetAtStart.value = scrollOffset.value;
    }
  });

  // Sync scroll position with keyboard movement
  useDerivedValue(() => {
    if (isScrollViewControlled.value) return;

    const isOpening = keyboard.state.value === KeyboardState.OPENING;
    const isClosing = keyboard.state.value === KeyboardState.CLOSING;

    if (isOpening) {
      const offset = scrollOffsetAtStart.value + Math.max(0, keyboard.height.value - bottom);
      scrollTo(ref, 0, offset, false);
    } else if (isClosing) {
      const offset = scrollOffsetAtStart.value - Math.max(0, keyboardHeight.value - keyboard.height.value - bottom);
      scrollTo(ref, 0, offset, false);
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
      contentContainerStyle={{ paddingTop: top + 16, paddingBottom: 8 }}
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
    useChat({ getAccessToken });
  const { bottom } = useSafeAreaInsets();

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
      <View className="flex-1 bg-background">
        {showSuggestions ? (
          // Empty state with suggestions - vertically centered
          <View className="flex-1 justify-center" style={{ paddingBottom: bottom + 80 }}>
            <SuggestedPrompts onSelect={handleSelectPrompt} />
          </View>
        ) : (
          // Message list with keyboard handling
          <KeyboardFriendlyScrollView>
            {/* Extra padding for first message to clear header */}
            <View className="h-10" />
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
          <View className="mx-4 mb-2 px-4 py-3 bg-destructive/10 rounded-xl">
            <Text className="text-destructive text-sm text-center">
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
