/**
 * UndoSendToast - Native mobile toast for queued messages with undo capability.
 *
 * Shows a 30-second countdown timer after a message is queued for sending.
 * Allows the user to cancel (undo) the send before the timer expires.
 */

import { useState, useEffect, useCallback } from "react";
import { View, Text, Pressable } from "react-native";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { PLATFORM_CONFIG, type ActionPlatform } from "@cued/shared";
import { cn } from "@/lib/utils";

/** Default undo window in milliseconds (30 seconds) */
const DEFAULT_UNDO_WINDOW_MS = 30 * 1000;

export interface UndoSendToastProps {
  /** Unique ID for the queued message */
  messageId: string;
  /** Platform the message is being sent on */
  platform: ActionPlatform;
  /** Recipient name or handle for display */
  recipientName: string;
  /** Preview of message text (truncated) */
  messagePreview?: string;
  /** Time remaining in ms (from server, for resuming after refresh) */
  timeRemainingMs?: number;
  /** Called when user clicks Undo button */
  onUndo: (messageId: string) => void | Promise<void>;
  /** Called when toast should be dismissed (timer expired, cancelled, or closed) */
  onDismiss?: (messageId: string, reason: "sent" | "cancelled" | "closed") => void;
}

export function UndoSendToast({
  messageId,
  platform,
  recipientName,
  messagePreview,
  timeRemainingMs,
  onUndo,
  onDismiss,
}: UndoSendToastProps): React.JSX.Element | null {
  // Initialize time remaining from props or default to full undo window
  const [timeRemaining, setTimeRemaining] = useState(
    timeRemainingMs ?? DEFAULT_UNDO_WINDOW_MS
  );
  const [isUndoing, setIsUndoing] = useState(false);
  const [isCancelled, setIsCancelled] = useState(false);

  // Countdown timer
  useEffect(() => {
    if (isCancelled || timeRemaining <= 0) return;

    const interval = setInterval(() => {
      setTimeRemaining((prev) => {
        const next = prev - 100;
        if (next <= 0) {
          clearInterval(interval);
          return 0;
        }
        return next;
      });
    }, 100);

    return () => clearInterval(interval);
  }, [isCancelled, timeRemaining]);

  // Auto-dismiss when timer expires
  useEffect(() => {
    if (timeRemaining <= 0 && !isCancelled) {
      onDismiss?.(messageId, "sent");
    }
  }, [timeRemaining, isCancelled, messageId, onDismiss]);

  const handleUndo = useCallback(async () => {
    if (isUndoing || isCancelled) return;

    setIsUndoing(true);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      await onUndo(messageId);
      setIsCancelled(true);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onDismiss?.(messageId, "cancelled");
    } catch {
      // If undo fails, continue countdown
      setIsUndoing(false);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, [isUndoing, isCancelled, messageId, onUndo, onDismiss]);

  const handleClose = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onDismiss?.(messageId, "closed");
  }, [messageId, onDismiss]);

  // Calculate progress percentage (100% = full, 0% = empty)
  const progressPercent = (timeRemaining / DEFAULT_UNDO_WINDOW_MS) * 100;
  const secondsRemaining = Math.ceil(timeRemaining / 1000);

  const platformConfig = PLATFORM_CONFIG[platform];

  // Don't render if cancelled
  if (isCancelled) return null;

  const content = (
    <View className="relative overflow-hidden rounded-2xl">
      {/* Progress bar at top */}
      <View
        className="absolute top-0 left-0 h-1 rounded-t-2xl"
        style={{
          width: `${progressPercent}%`,
          backgroundColor: platformConfig.color,
        }}
      />

      <View className="flex-row items-start gap-3 p-4 pt-5">
        {/* Platform indicator */}
        <View
          className="w-8 h-8 rounded-full items-center justify-center"
          style={{ backgroundColor: `${platformConfig.color}20` }}
        >
          <Text
            className="text-sm font-semibold"
            style={{ color: platformConfig.color }}
          >
            {platformConfig.letter}
          </Text>
        </View>

        {/* Content */}
        <View className="flex-1">
          <View className="flex-row items-center justify-between gap-2">
            <Text className="text-sm font-medium text-foreground flex-1" numberOfLines={1}>
              Sending to {recipientName}
            </Text>
            <Text className="text-xs text-muted-foreground tabular-nums">
              {secondsRemaining}s
            </Text>
          </View>

          {messagePreview && (
            <Text
              className="mt-1 text-xs text-muted-foreground"
              numberOfLines={2}
            >
              {messagePreview}
            </Text>
          )}

          {/* Undo button */}
          <Pressable
            onPress={handleUndo}
            disabled={isUndoing || timeRemaining <= 0}
            className={cn(
              "mt-3 px-3 py-1.5 rounded-lg border border-border self-start",
              (isUndoing || timeRemaining <= 0) && "opacity-50"
            )}
          >
            <Text className="text-xs font-medium text-foreground">
              {isUndoing ? "Cancelling..." : "Undo"}
            </Text>
          </Pressable>
        </View>

        {/* Close button */}
        <Pressable
          onPress={handleClose}
          className="p-1 rounded-lg"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <SymbolView
            name="xmark"
            size={16}
            tintColor="#9CA3AF"
            weight="medium"
          />
        </Pressable>
      </View>
    </View>
  );

  // Use GlassView on iOS 26+ for liquid glass effect
  if (isLiquidGlassAvailable()) {
    return (
      <GlassView
        style={{
          borderRadius: 16,
          marginHorizontal: 16,
          marginBottom: 16,
        }}
      >
        {content}
      </GlassView>
    );
  }

  return (
    <View
      className="mx-4 mb-4 bg-card border border-border rounded-2xl shadow-lg"
    >
      {content}
    </View>
  );
}

export default UndoSendToast;
