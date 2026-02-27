/**
 * Actions tab main screen.
 * Displays pending actions as swipeable cards using Convex data.
 * Action buttons and queue state are shown in the BottomAccessory and sheet.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { View, Text } from "react-native";
import * as Haptics from "expo-haptics";
import { useRouter, useSegments } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { BottomSheet, Group, Host, RNHostView } from "@expo/ui/swift-ui";
import {
  presentationDetents,
  presentationDragIndicator,
} from "@expo/ui/swift-ui/modifiers";
import { useMutation, useQuery } from "convex/react";
import { FadeIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AnimatedView } from "@/components/animated";
import { api } from "@cued/convex";
import {
  type DisplayMessage,
  type ActionPlatform,
  type ContactHandle,
  type EnrichedAction,
} from "@cued/shared";
import { ActionListSheet } from "@/components/action-list-sheet";
import { CardStack } from "@/components/card-stack";
import {
  MessageResponseCard,
  ResolveContactCard,
  type MergeSource,
} from "@/components/cards";
import { ErrorBoundary } from "@/components/error-boundary";
import { SkeletonStack } from "@/components/skeleton-card";
import { useActionQueue } from "@/contexts/action-queue-context";
import { useElectronPrescence } from "@/contexts/electron-presence-context";
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
  isCompleted?: boolean;
}

/** Action types that use MessageResponseCard */
const MESSAGE_ACTION_TYPES = ["respond", "follow_up", "send_message"];

const ACTION_CONTEXT_MESSAGE_LIMIT = 15;
const MESSAGE_PAGE_SIZE = 25;

export default function ActionsScreen(): React.JSX.Element | null {
  const router = useRouter();
  const segments = useSegments();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const {
    actions,
    isLoading,
    focusedActionId,
    setFocusedActionId,
    isSheetOpen,
    setIsSheetOpen,
    completedActionCache,
    markActionCompleted,
    clearCompletedAction,
  } = useActionQueue();
  const { isOnline: isDesktopOnline } = useElectronPrescence();
  const swipeAction = useMutation(api.actions.swipeAction);

  // Clear completed action cache when user navigates to a different action via sheet
  useEffect(() => {
    if (focusedActionId) {
      // Clear all cached completed actions when user focuses a new action
      for (const id of Object.keys(completedActionCache)) {
        clearCompletedAction(id);
      }
    }
    // Only react to focusedActionId changes, not cache changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedActionId]);

  // Unmount card stack when leaving the tab to avoid stale glass/animation state
  // @ts-expect-error - segments is an array of strings
  const isActive = segments[1] === "(actions)";

  // Reorder actions to show focused action on top, and prepend completed actions
  const displayActions = useMemo(() => {
    let base = actions;
    if (focusedActionId) {
      const focusedIdx = actions.findIndex((a) => a._id === focusedActionId);
      if (focusedIdx > 0) {
        const focused = actions[focusedIdx];
        base = [
          focused,
          ...actions.slice(0, focusedIdx),
          ...actions.slice(focusedIdx + 1),
        ];
      }
    }
    // Prepend cached completed actions that are no longer in the pending query
    const cachedIds = Object.keys(completedActionCache);
    const cached = cachedIds
      .filter((id) => !base.some((a) => a._id === id))
      .map((id) => completedActionCache[id]);
    return [...cached, ...base];
  }, [actions, focusedActionId, completedActionCache]);

  // Fetch details for the current top card and prefetch the next card.
  const topAction = displayActions[0];
  const nextAction = displayActions[1];
  const topActionId = topAction?._id as Id<"actions"> | undefined;
  const nextActionId = nextAction?._id as Id<"actions"> | undefined;

  // Fetch context for the top action (includes messages)
  const actionContext = useQuery(
    api.actions.getActionWithContext,
    topActionId && isFocused
      ? { actionId: topActionId, messageLimit: ACTION_CONTEXT_MESSAGE_LIMIT }
      : "skip",
  );

  // Keep one action ahead warm so swiping to the next card is instant.
  useQuery(
    api.actions.getActionWithContext,
    nextActionId && isFocused
      ? { actionId: nextActionId, messageLimit: ACTION_CONTEXT_MESSAGE_LIMIT }
      : "skip",
  );

  // Paginated message loading for top action's conversation
  const [messageLimit, setMessageLimit] = useState(MESSAGE_PAGE_SIZE);

  // Reset message limit when top action changes
  const prevTopActionIdRef = useRef(topActionId);
  if (topActionId !== prevTopActionIdRef.current) {
    prevTopActionIdRef.current = topActionId;
    setMessageLimit(MESSAGE_PAGE_SIZE);
  }

  const topConversationId = actionContext?.conversation?._id;
  const messagesResult = useQuery(
    api.messages.getMessages,
    topConversationId
      ? { conversationId: topConversationId as Id<"conversations">, limit: messageLimit }
      : "skip",
  );

  const nextConversationId = nextAction?.conversationId
    ? (nextAction.conversationId as Id<"conversations">)
    : null;
  useQuery(
    api.messages.getMessages,
    nextConversationId && isFocused
      ? { conversationId: nextConversationId, limit: MESSAGE_PAGE_SIZE }
      : "skip",
  );

  // Map paginated messages to DisplayMessage format (getMessages returns newest-first)
  const topActionMessages: DisplayMessage[] = useMemo(() => {
    const messages = messagesResult?.messages;
    if (!messages) {
      // Fall back to context messages while paginated query loads
      const ctxMessages = actionContext?.messages;
      if (!ctxMessages) return [];
      return ctxMessages.map((msg) => ({
        _id: msg._id,
        content: msg.content,
        sentAt: msg.sentAt,
        isFromMe: msg.isFromMe,
        senderName: msg.senderName,
        status: msg.status,
        reactions: msg.reactions ?? null,
      }));
    }

    return [...messages].reverse().map((msg) => ({
      _id: msg._id,
      content: msg.content,
      sentAt: msg.sentAt,
      isFromMe: msg.isFromMe,
      senderName: msg.sender?.displayName ?? (msg.isFromMe ? "You" : null),
      status: msg.status,
      reactions: msg.reactions ?? null,
    }));
  }, [messagesResult?.messages, actionContext?.messages]);

  const hasMoreMessages = messagesResult?.nextCursor != null;
  const handleLoadMoreMessages = useCallback(() => {
    setMessageLimit((prev) => prev + MESSAGE_PAGE_SIZE);
  }, []);
  const isLoadingMoreMessages = messageLimit > MESSAGE_PAGE_SIZE && messagesResult === undefined;

  // Track response text per action (key = action._id)
  const [responseTexts, setResponseTexts] = useState<Record<string, string>>(
    {},
  );

  // Transform actions to CardStack items
  const cardItems: ActionItem[] = displayActions.map((action) => ({
    id: action._id,
    action: action as EnrichedAction,
    isCompleted: action._id in completedActionCache,
  }));

  const getResponseText = useCallback(
    (action: EnrichedAction): string => {
      return responseTexts[action._id] ?? "";
    },
    [responseTexts],
  );

  const handleResponseChange = useCallback((actionId: string, text: string) => {
    setResponseTexts((prev) => ({ ...prev, [actionId]: text }));
  }, []);

  // Handle swipe with Convex mutation
  const handleSwipe = useCallback(
    async (item: ActionItem, direction: SwipeDirection) => {
      const { action } = item;
      const isAlreadyCompleted = action._id in completedActionCache;

      // If this action is already completed, any swipe just dismisses it
      if (isAlreadyCompleted) {
        clearCompletedAction(action._id);
        return;
      }

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

      // Right = send with response text, then keep card visible as completed
      const responseText = getResponseText(action);

      try {
        await swipeAction({
          actionId: action._id as Id<"actions">,
          direction,
          responseText,
        });
        await Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        );

        // Cache action locally so it stays visible after Convex removes it
        markActionCompleted(action);

      } catch (error) {
        console.error("Failed to swipe action:", error);
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    },
    [
      router,
      swipeAction,
      getResponseText,
      focusedActionId,
      setFocusedActionId,
      completedActionCache,
      markActionCompleted,
      clearCompletedAction,
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
            onSend={() => handleSwipe(item, "right")}
            hasMore={isTopCard ? hasMoreMessages : undefined}
            onLoadMore={isTopCard ? handleLoadMoreMessages : undefined}
            isLoadingMore={isTopCard ? isLoadingMoreMessages : undefined}
            isCompleted={item.isCompleted}
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
        const c2Link = isTopCard
          ? getContactDeeplink(secondary?.handles)
          : null;

        return (
          <ResolveContactCard
            contact1={{
              name: contact?.displayName ?? action.contactName ?? "Unknown",
              company: contact?.company,
              avatarUrl: contact?.avatarUrl ?? null,
              handles: mapHandles(contact?.handles),
            }}
            contact2={{
              name:
                secondary?.displayName ??
                action.secondaryContactName ??
                "Unknown",
              company: secondary?.company,
              avatarUrl: secondary?.avatarUrl ?? null,
              handles: mapHandles(secondary?.handles),
            }}
            confidence={action.mergeConfidence ?? 0}
            source={(action.mergeSource ?? "email_match") as MergeSource}
            reasoning={action.mergeReasoning}
            onOpenContact1={
              c1Link?.type === "available"
                ? () => openDeeplink(c1Link.url)
                : null
            }
            onOpenContact2={
              c2Link?.type === "available"
                ? () => openDeeplink(c2Link.url)
                : null
            }
            contact1Platform={c1Link?.platform ?? null}
            contact2Platform={c2Link?.platform ?? null}
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
    [topActionMessages, getResponseText, isDesktopOnline, actionContext?.conversation, actionContext?.contact, actionContext?.secondaryContact, handleResponseChange, handleSwipe, hasMoreMessages, handleLoadMoreMessages, isLoadingMoreMessages],
  );

  if (isLoading) {
    return <SkeletonStack />;
  }

  // Top padding to clear transparent header (safe area + nav bar)
  const paddingTop = insets.top + 64;
  // Bottom padding to avoid overlap with tab bar + toolbar
  const paddingBottom = 56 + 50 + insets.bottom; // tab bar + toolbar + safe area

  if (!isActive) return null;

  return (
    <ErrorBoundary>
      <AnimatedView
        entering={FadeIn.duration(150)}
        className="flex-1 bg-background"
      >
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
            <Group
              modifiers={[
                presentationDetents(["medium", "large"]),
                presentationDragIndicator("hidden"),
              ]}
            >
              <RNHostView>
                <ActionListSheet />
              </RNHostView>
            </Group>
          </BottomSheet>
        </Host>
      </AnimatedView>
    </ErrorBoundary>
  );
}
