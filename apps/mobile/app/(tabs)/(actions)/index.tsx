/**
 * Actions tab main screen.
 * Displays pending actions as swipeable cards using Convex data.
 * Action buttons and undo toasts are now in the BottomAccessory and sheet.
 */

import { useState, useCallback, useMemo, useEffect } from "react";
import { View, Text } from "react-native";
import * as Haptics from "expo-haptics";
import { useRouter, useSegments } from "expo-router";
import { BottomSheet, Group, Host, RNHostView } from "@expo/ui/swift-ui";
import { presentationDetents } from "@expo/ui/swift-ui/modifiers";
import { useMutation, useQuery } from "convex/react";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "@cued/convex/convex/_generated/api";
import {
  type DisplayMessage,
  type ContactFormData,
  type ActionPlatform,
  type ContactHandle,
  type EnrichedAction,
} from "@cued/shared";
import { ActionListSheet } from "@/components/action-list-sheet";
import { CardStack } from "@/components/card-stack";
import {
  MessageResponseCard,
  ContactCard,
  ResolveContactCard,
  type MergeSource,
} from "@/components/cards";
import { ErrorBoundary } from "@/components/error-boundary";
import { SkeletonStack } from "@/components/skeleton-card";
import { useActionQueue } from "@/contexts/action-queue-context";
import { useElectronPresence } from "@/hooks/useElectronPresence";
import {
  getPlatformDeeplink,
  getContactDeeplink,
  openDeeplink,
} from "@/lib/utils";
import type { SwipeDirection } from "@/components/swipeable-card";
import type { Id } from "@cued/convex/convex/_generated/dataModel";

/** Map action to CardStack item format */
interface ActionItem {
  id: string;
  action: EnrichedAction;
}

/** Action types that use MessageResponseCard */
const MESSAGE_ACTION_TYPES = ["respond", "follow_up", "send_message"];

/** Action types that use ContactCard */
const CONTACT_ACTION_TYPES = ["eod_contact", "new_connection"];

export default function ActionsScreen(): React.JSX.Element {
  const router = useRouter();
  const segments = useSegments();
  const insets = useSafeAreaInsets();
  const {
    actions,
    isLoading,
    addQueuedMessage,
    focusedActionId,
    setFocusedActionId,
    isSheetOpen,
    setIsSheetOpen,
  } = useActionQueue();
  const { isOnline: isDesktopOnline } = useElectronPresence();
  const swipeAction = useMutation(api.actions.swipeAction);

  // Fade out card stack when leaving the tab to avoid visual glitches
  // @ts-expect-error - segments is an array of strings
  const isActive = segments[1] === "(actions)";
  const screenOpacity = useSharedValue(1);
  const fadeStyle = useAnimatedStyle(() => ({ opacity: screenOpacity.value }));

  useEffect(() => {
    screenOpacity.value = withTiming(isActive ? 1 : 0, { duration: 150 });
  }, [isActive, screenOpacity]);

  // Reorder actions to show focused action on top (without mutating queue)
  const displayActions = useMemo(() => {
    if (!focusedActionId) return actions;
    const focusedIdx = actions.findIndex((a) => a._id === focusedActionId);
    if (focusedIdx <= 0) return actions;
    const focused = actions[focusedIdx];
    return [
      focused,
      ...actions.slice(0, focusedIdx),
      ...actions.slice(focusedIdx + 1),
    ];
  }, [actions, focusedActionId]);

  // Get the top action ID for fetching context with messages
  const topActionId = displayActions[0]?._id as Id<"actions"> | undefined;

  // Fetch context for the top action (includes messages)
  const actionContext = useQuery(
    api.actions.getActionWithContext,
    topActionId ? { actionId: topActionId, messageLimit: 15 } : "skip",
  );

  // Map messages from context to DisplayMessage format
  const topActionMessages: DisplayMessage[] = useMemo(() => {
    const messages = actionContext?.messages;
    if (!messages) return [];

    return messages.map((msg) => ({
      _id: msg._id,
      content: msg.content,
      sentAt: msg.sentAt,
      isFromMe: msg.isFromMe,
      senderName: msg.senderName,
      status: msg.status,
      reactions: msg.reactions?.map((r) => r.emoji) ?? null,
    }));
  }, [actionContext?.messages]);

  // Track response text per action (key = action._id)
  const [responseTexts, setResponseTexts] = useState<Record<string, string>>(
    {},
  );

  // Track contact form data per action (key = action._id)
  const [contactForms, setContactForms] = useState<
    Record<string, ContactFormData>
  >({});

  // Transform actions to CardStack items
  const cardItems: ActionItem[] = displayActions.map((action) => ({
    id: action._id,
    action: action as EnrichedAction,
  }));

  const getResponseText = useCallback(
    (action: EnrichedAction): string => {
      return responseTexts[action._id] ?? "";
    },
    [responseTexts],
  );

  const getContactFormData = useCallback(
    (action: EnrichedAction): ContactFormData => {
      return (
        contactForms[action._id] ?? {
          name: action.contactName ?? "",
          company: "",
          tags: "",
          notes: "",
        }
      );
    },
    [contactForms],
  );

  const handleResponseChange = useCallback((actionId: string, text: string) => {
    setResponseTexts((prev) => ({ ...prev, [actionId]: text }));
  }, []);

  const handleContactFormChange = useCallback(
    (actionId: string, data: ContactFormData) => {
      setContactForms((prev) => ({ ...prev, [actionId]: data }));
    },
    [],
  );

  // Handle swipe with Convex mutation
  const handleSwipe = useCallback(
    async (item: ActionItem, direction: SwipeDirection) => {
      const { action } = item;

      // Clear focused action on swipe
      if (focusedActionId === action._id) {
        setFocusedActionId(null);
      }

      // Snooze: navigate to picker sheet
      if (direction === "up") {
        router.push({
          pathname: "/(tabs)/(actions)/snooze-picker",
          params: { actionId: action._id },
        });
        return;
      }

      // Left = skip
      if (direction === "left") {
        try {
          await swipeAction({
            actionId: action._id as Id<"actions">,
            direction,
          });
          await Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success,
          );
        } catch (error) {
          console.error("Failed to skip action:", error);
          await Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Error,
          );
        }
        return;
      }

      // Right = send with response text
      const responseText =
        action.type === "new_connection"
          ? getContactFormData(action).notes
          : getResponseText(action);

      try {
        const result = await swipeAction({
          actionId: action._id as Id<"actions">,
          direction,
          responseText,
        });
        await Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        );

        // Add queued message to context for display in accessory/sheet
        if (result?.queuedMessageId && action.platform) {
          addQueuedMessage({
            messageId: result.queuedMessageId as string,
            platform: action.platform as ActionPlatform,
            recipientName: action.contactName ?? "Unknown",
            messagePreview: responseText,
            scheduledFor: Date.now() + 30 * 1000,
          });
        }
      } catch (error) {
        console.error("Failed to swipe action:", error);
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    },
    [
      router,
      swipeAction,
      getResponseText,
      getContactFormData,
      addQueuedMessage,
      focusedActionId,
      setFocusedActionId,
    ],
  );

  // Render card based on action type
  const renderCard = useCallback(
    (item: ActionItem, index: number): React.JSX.Element => {
      const { action } = item;
      const isTopCard = index === 0;

      if (MESSAGE_ACTION_TYPES.includes(action.type)) {
        const messages = isTopCard ? topActionMessages : [];
        const platform = action.platform ?? undefined;

        // Build deep link for "open in app"
        let onOpenInApp: (() => void) | null = null;
        if (isTopCard && platform) {
          const result = getPlatformDeeplink(
            platform,
            actionContext?.conversation ?? null,
            actionContext?.contact ?? null,
          );
          if (result?.type === "available") {
            onOpenInApp = () => openDeeplink(result.url);
          }
        }

        return (
          <MessageResponseCard
            personName={action.contactName ?? "Unknown"}
            messageTimestamp={action.createdAt}
            messages={messages}
            responseText={getResponseText(action)}
            onResponseChange={(text) => handleResponseChange(action._id, text)}
            platform={(platform as ActionPlatform) ?? undefined}
            isDesktopOnline={isDesktopOnline}
            onOpenInApp={onOpenInApp}
          />
        );
      }

      if (action.type === "resolve_contact") {
        const contact = isTopCard ? actionContext?.contact : null;
        const secondary = isTopCard ? actionContext?.secondaryContact : null;
        const mapHandles = (
          handles?: { handleType: string; handle: string; platform: string }[],
        ): ContactHandle[] =>
          (handles ?? []).map((h) => ({
            type: h.handleType as ContactHandle["type"],
            value: h.handle,
            platform: h.platform as ContactHandle["platform"],
          }));

        // Build deep links for each contact's "Open" button
        const c1Link = isTopCard ? getContactDeeplink(contact?.handles) : null;
        const c2Link = isTopCard ? getContactDeeplink(secondary?.handles) : null;

        return (
          <ResolveContactCard
            contact1={{
              name: contact?.displayName ?? action.contactName ?? "Unknown",
              company: contact?.company,
              handles: mapHandles(contact?.handles),
            }}
            contact2={{
              name:
                secondary?.displayName ??
                action.secondaryContactName ??
                "Unknown",
              company: secondary?.company,
              handles: mapHandles(secondary?.handles),
            }}
            confidence={action.mergeConfidence ?? 0}
            source={(action.mergeSource ?? "email_match") as MergeSource}
            reasoning={action.mergeReasoning}
            onOpenContact1={c1Link?.type === "available" ? () => openDeeplink(c1Link.url) : null}
            onOpenContact2={c2Link?.type === "available" ? () => openDeeplink(c2Link.url) : null}
            contact1Platform={c1Link?.platform ?? null}
            contact2Platform={c2Link?.platform ?? null}
          />
        );
      }

      if (CONTACT_ACTION_TYPES.includes(action.type)) {
        const platform = action.platform ?? undefined;

        // Build deep link for contact cards
        let onOpenInApp: (() => void) | null = null;
        if (isTopCard && platform) {
          const result = getPlatformDeeplink(
            platform,
            actionContext?.conversation ?? null,
            actionContext?.contact ?? null,
          );
          if (result?.type === "available") {
            onOpenInApp = () => openDeeplink(result.url);
          }
        }

        return (
          <ContactCard
            personName={action.contactName ?? "New Contact"}
            createdAt={action.createdAt}
            platform={(platform as ActionPlatform) ?? undefined}
            formData={getContactFormData(action)}
            onFormChange={(data) => handleContactFormChange(action._id, data)}
            onOpenInApp={onOpenInApp}
          />
        );
      }

      return (
        <View className="flex-1 p-4 items-center justify-center">
          <Text className="text-sf-label text-center text-lg font-semibold">
            {action.type}
          </Text>
          <Text className="text-sf-secondaryLabel text-center text-sm mt-2">
            {action.contactName ?? "Unknown contact"}
          </Text>
          {action.reason && (
            <Text className="text-sf-tertiaryLabel text-center text-xs mt-1">
              {action.reason}
            </Text>
          )}
        </View>
      );
    },
    [
      getResponseText,
      getContactFormData,
      handleResponseChange,
      handleContactFormChange,
      topActionMessages,
      actionContext,
      isDesktopOnline,
    ],
  );

  if (isLoading) {
    return <SkeletonStack />;
  }

  // Top padding to clear transparent header (safe area + nav bar)
  const paddingTop = insets.top + 64;
  // Bottom padding to avoid overlap with tab bar + toolbar
  const paddingBottom = 56 + 50 + insets.bottom; // tab bar + toolbar + safe area

  return (
    <ErrorBoundary>
      <Animated.View className="flex-1 bg-background" style={[fadeStyle]}>
        <View style={{ flex: 1, paddingTop, paddingBottom }}>
          <CardStack
            actions={cardItems}
            totalCount={displayActions.length}
            onSwipe={handleSwipe}
            renderCard={renderCard}
          />
        </View>

        <Host style={{ position: "absolute" }}>
          <BottomSheet
            isPresented={isSheetOpen}
            onIsPresentedChange={setIsSheetOpen}
          >
            <Group modifiers={[presentationDetents(["medium", "large"])]}>
              <RNHostView>
                <ActionListSheet />
              </RNHostView>
            </Group>
          </BottomSheet>
        </Host>
      </Animated.View>
    </ErrorBoundary>
  );
}
