/**
 * SendMessageSheet - Mobile bottom sheet for composing and sending messages.
 *
 * A modal-based UI for sending messages across platforms on mobile.
 * Uses React Native Modal with iOS-optimized styling.
 */

import { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  Modal,
  Pressable,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  useColorScheme,
} from "react-native";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { PLATFORM_CONFIG, type ActionPlatform } from "@cued/shared";
import { cn } from "@/lib/utils";

/** Contact with available platforms for sending */
export interface SendMessageContact {
  /** Contact ID (e.g., Convex ID) */
  id: string;
  /** Display name */
  name: string;
  /** Available platforms with their handles */
  platforms: {
    platform: ActionPlatform;
    handle: string;
    /** Optional display label (e.g., "Work", "Personal") */
    label?: string;
  }[];
}

export interface SendMessageSheetProps {
  /** Whether the sheet is visible */
  visible: boolean;
  /** Callback when visibility changes */
  onClose: () => void;
  /** Pre-selected contact */
  contact: SendMessageContact;
  /** Pre-selected platform (optional) */
  defaultPlatform?: ActionPlatform;
  /** Pre-filled message text (optional) */
  defaultMessage?: string;
  /** Conversation ID to associate with the message (optional) */
  conversationId?: string;
  /** Called when user sends the message */
  onSend: (params: {
    platform: ActionPlatform;
    recipientHandle: string;
    recipientContactId?: string;
    text: string;
    conversationId?: string;
  }) => Promise<{ messageId: string; scheduledFor: number } | void>;
}

/**
 * Platform selector button for the send sheet.
 */
function PlatformButton({
  platformInfo,
  isSelected,
  onPress,
}: {
  platformInfo: { platform: ActionPlatform; handle: string; label?: string };
  isSelected: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const config = PLATFORM_CONFIG[platformInfo.platform];

  return (
    <Pressable
      onPress={onPress}
      className={cn(
        "flex-row items-center gap-2 px-3 py-2 rounded-xl border",
        isSelected
          ? "border-primary bg-primary/10"
          : "border-border bg-card"
      )}
    >
      <View
        className="w-6 h-6 rounded-full items-center justify-center"
        style={{ backgroundColor: `${config.color}20` }}
      >
        <Text
          className="text-xs font-semibold"
          style={{ color: config.color }}
        >
          {config.letter}
        </Text>
      </View>
      <View className="flex-1">
        <Text className="text-sm font-medium text-foreground">
          {config.label}
        </Text>
        {platformInfo.label && (
          <Text className="text-xs text-muted-foreground">
            {platformInfo.label}
          </Text>
        )}
      </View>
      {isSelected && (
        <SymbolView
          name="checkmark.circle.fill"
          size={18}
          tintColor={config.color}
        />
      )}
    </Pressable>
  );
}

export function SendMessageSheet({
  visible,
  onClose,
  contact,
  defaultPlatform,
  defaultMessage = "",
  conversationId,
  onSend,
}: SendMessageSheetProps): React.JSX.Element {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";

  // Form state
  const [selectedPlatform, setSelectedPlatform] = useState<ActionPlatform | null>(
    defaultPlatform ?? contact.platforms[0]?.platform ?? null
  );
  const [message, setMessage] = useState(defaultMessage);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when modal opens/closes or contact changes
  useEffect(() => {
    if (visible) {
      setSelectedPlatform(defaultPlatform ?? contact.platforms[0]?.platform ?? null);
      setMessage(defaultMessage);
      setError(null);
    }
  }, [visible, contact, defaultPlatform, defaultMessage]);

  // Get selected platform info
  const selectedPlatformInfo = contact.platforms.find(
    (p) => p.platform === selectedPlatform
  );

  // Can send if we have a platform, handle, and message
  const canSend =
    selectedPlatform &&
    selectedPlatformInfo &&
    message.trim().length > 0 &&
    !isSending;

  const handleSend = useCallback(async () => {
    if (!canSend || !selectedPlatform || !selectedPlatformInfo) return;

    setIsSending(true);
    setError(null);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      await onSend({
        platform: selectedPlatform,
        recipientHandle: selectedPlatformInfo.handle,
        recipientContactId: contact.id,
        text: message.trim(),
        conversationId,
      });

      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsSending(false);
    }
  }, [
    canSend,
    selectedPlatform,
    selectedPlatformInfo,
    contact.id,
    message,
    conversationId,
    onSend,
    onClose,
  ]);

  const handleClose = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  const handlePlatformSelect = useCallback((platform: ActionPlatform) => {
    Haptics.selectionAsync();
    setSelectedPlatform(platform);
  }, []);

  const platformConfig = selectedPlatform ? PLATFORM_CONFIG[selectedPlatform] : null;
  const iconColor = isDark ? "#a1a1aa" : "#71717a";

  const sheetContent = (
    <View className="flex-1 justify-end">
      {/* Backdrop */}
      <Pressable
        className="absolute inset-0 bg-black/50"
        onPress={handleClose}
      />

      {/* Sheet */}
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
      >
        <View
          className={cn(
            "rounded-t-3xl pb-8",
            isLiquidGlassAvailable() ? "" : "bg-card"
          )}
        >
          {/* Handle */}
          <View className="items-center pt-3 pb-4">
            <View className="w-10 h-1 rounded-full bg-muted-foreground/30" />
          </View>

          <ScrollView
            className="max-h-[70vh]"
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="px-4 pb-4"
          >
            {/* Header */}
            <View className="flex-row items-center justify-between mb-4">
              <Text className="text-lg font-semibold text-foreground">
                Send to {contact.name}
              </Text>
              <Pressable
                onPress={handleClose}
                className="p-2 rounded-full bg-muted"
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <SymbolView
                  name="xmark"
                  size={16}
                  tintColor={iconColor}
                  weight="medium"
                />
              </Pressable>
            </View>

            {/* Platform selector - show if multiple platforms */}
            {contact.platforms.length > 1 && (
              <View className="mb-4">
                <Text className="text-sm font-medium text-muted-foreground mb-2">
                  Select Platform
                </Text>
                <View className="gap-2">
                  {contact.platforms.map((p) => (
                    <PlatformButton
                      key={p.platform}
                      platformInfo={p}
                      isSelected={selectedPlatform === p.platform}
                      onPress={() => handlePlatformSelect(p.platform)}
                    />
                  ))}
                </View>
              </View>
            )}

            {/* Single platform indicator */}
            {contact.platforms.length === 1 && platformConfig && (
              <View className="flex-row items-center gap-2 mb-4">
                <View
                  className="w-6 h-6 rounded-full items-center justify-center"
                  style={{ backgroundColor: `${platformConfig.color}20` }}
                >
                  <Text
                    className="text-xs font-semibold"
                    style={{ color: platformConfig.color }}
                  >
                    {platformConfig.letter}
                  </Text>
                </View>
                <Text className="text-sm text-muted-foreground">
                  via {platformConfig.label}
                </Text>
              </View>
            )}

            {/* Message composer */}
            <View className="mb-4">
              <Text className="text-sm font-medium text-muted-foreground mb-2">
                Message
              </Text>
              <TextInput
                value={message}
                onChangeText={setMessage}
                placeholder="Type your message..."
                placeholderTextColor={iconColor}
                multiline
                className="min-h-[120px] max-h-[200px] bg-muted rounded-xl p-3 text-foreground text-base"
                style={{ textAlignVertical: "top" }}
                accessibilityLabel="Message input"
                autoFocus
              />
            </View>

            {/* Error display */}
            {error && (
              <View className="mb-4 p-3 rounded-xl bg-destructive/10">
                <Text className="text-sm text-destructive">{error}</Text>
              </View>
            )}

            {/* Action buttons */}
            <View className="flex-row gap-3">
              <Pressable
                onPress={handleClose}
                disabled={isSending}
                className={cn(
                  "flex-1 py-3 rounded-xl border border-border items-center",
                  isSending && "opacity-50"
                )}
              >
                <Text className="text-base font-medium text-foreground">
                  Cancel
                </Text>
              </Pressable>

              <Pressable
                onPress={handleSend}
                disabled={!canSend}
                className={cn(
                  "flex-1 flex-row gap-2 py-3 rounded-xl items-center justify-center",
                  canSend ? "bg-primary" : "bg-muted"
                )}
              >
                {!isSending && (
                  <SymbolView
                    name="paperplane.fill"
                    size={16}
                    tintColor={canSend ? "#FFFFFF" : iconColor}
                  />
                )}
                <Text
                  className={cn(
                    "text-base font-medium",
                    canSend ? "text-white" : "text-muted-foreground"
                  )}
                >
                  {isSending ? "Sending..." : "Send"}
                </Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </View>
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      {isLiquidGlassAvailable() ? (
        <GlassView style={{ flex: 1 }}>{sheetContent}</GlassView>
      ) : (
        sheetContent
      )}
    </Modal>
  );
}

export default SendMessageSheet;
