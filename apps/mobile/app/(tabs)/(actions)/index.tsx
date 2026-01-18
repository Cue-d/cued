/**
 * Actions tab main screen.
 * Displays pending actions as swipeable cards using Convex data.
 */

import { useState, useCallback, useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { View, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useActions } from "@/hooks/useActions";
import { CardStack } from "@/components/card-stack";
import {
  MessageResponseCard,
  ContactCard,
  type ActionPlatform,
  type DisplayMessage,
  type ContactFormData,
} from "@/components/cards";
import type { SwipeDirection } from "@/components/swipeable-card";
import { ActionButtons } from "@/components/action-buttons";
import { SkeletonStack } from "@/components/skeleton-card";
import { ErrorBoundary } from "@/components/error-boundary";
import { api } from "@prm/convex/convex/_generated/api";
import type { Id } from "@prm/convex/convex/_generated/dataModel";

/** Action type from Convex getPendingActions */
type EnrichedAction = {
  _id: string;
  type: string;
  status: string;
  priority: number;
  draftMessage: string | null;
  draftResponse: string | null;
  reason: string | null;
  llmReason: string | null;
  createdAt: number;
  snoozedUntil: number | null;
  completedAt: number | null;
  discardedAt: number | null;
  conversationId: string | null;
  contactId: string | null;
  contactName: string | null;
  secondaryContactId: string | null;
  secondaryContactName: string | null;
  mergeSuggestionId: string | null;
  platform: string | null;
};

/** Map action to CardStack item format */
interface ActionItem {
  id: string;
  action: EnrichedAction;
}

/** Action types that use MessageResponseCard */
const MESSAGE_ACTION_TYPES = ["respond", "follow_up"];

/** Action types that use ContactCard */
const CONTACT_ACTION_TYPES = ["eod_contact", "new_connection"];

export default function ActionsScreen(): React.JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { actions, isLoading } = useActions({ limit: 20 });
  const swipeAction = useMutation(api.actions.swipeAction);
  const [triggerSwipe, setTriggerSwipe] = useState<SwipeDirection | null>(null);

  // Get the top action ID for fetching context with messages
  const topActionId = actions[0]?._id as Id<"actions"> | undefined;

  // Fetch context for the top action (includes messages)
  const actionContext = useQuery(
    api.actions.getActionWithContext,
    topActionId ? { actionId: topActionId, messageLimit: 15 } : "skip"
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
      attachments: msg.attachments?.map((att) => ({
        filename: att.filename ?? null,
        mimeType: att.mimeType ?? null,
        url: att.url ?? null,
        thumbnailUrl: att.thumbnailUrl ?? null,
      })),
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
  const cardItems: ActionItem[] = actions.map((action) => ({
    id: action._id,
    action,
  }));

  // Get response text for an action (prefer user edits, then draft)
  const getResponseText = useCallback(
    (action: EnrichedAction): string => {
      return (
        responseTexts[action._id] ??
        action.draftResponse ??
        action.draftMessage ??
        ""
      );
    },
    [responseTexts],
  );

  // Get contact form data for an action
  const getContactFormData = useCallback(
    (action: EnrichedAction): ContactFormData => {
      return (
        contactForms[action._id] ?? {
          name: action.contactName ?? "",
          company: "",
          tags: "",
          notes: action.draftResponse ?? "",
        }
      );
    },
    [contactForms],
  );

  // Handle response text change
  const handleResponseChange = useCallback(
    (actionId: string, text: string) => {
      setResponseTexts((prev) => ({ ...prev, [actionId]: text }));
    },
    [],
  );

  // Handle contact form change
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
      setTriggerSwipe(null);

      // Snooze: navigate to picker sheet
      if (direction === "up") {
        router.push({
          pathname: "/(tabs)/(actions)/snooze-picker",
          params: { actionId: action._id },
        });
        return;
      }

      // Right = send, Left = skip
      const isSending = direction === "right";
      const responseText = isSending ? getResponseText(action) : undefined;
      const notes =
        isSending && action.type === "new_connection"
          ? getContactFormData(action).notes
          : undefined;

      try {
        await swipeAction({
          actionId: action._id as Id<"actions">,
          direction,
          responseText: notes ?? responseText,
        });
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (error) {
        console.error("Failed to swipe action:", error);
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    },
    [router, swipeAction, getResponseText, getContactFormData],
  );

  // Handle button press from ActionButtons
  const handleButtonSwipe = useCallback(
    (direction: SwipeDirection) => {
      if (actions.length === 0) return;
      setTriggerSwipe(direction);
    },
    [actions.length],
  );

  // Render card based on action type
  const renderCard = useCallback(
    (item: ActionItem, index: number): React.JSX.Element => {
      const { action } = item;
      const isTopCard = index === 0;

      // Message-based actions (respond, follow_up)
      if (MESSAGE_ACTION_TYPES.includes(action.type)) {
        // Use messages from context for the top card, empty for others
        const messages = isTopCard ? topActionMessages : [];

        return (
          <MessageResponseCard
            personName={action.contactName ?? "Unknown"}
            messageTimestamp={action.createdAt}
            messages={messages}
            responseText={getResponseText(action)}
            onResponseChange={(text) => handleResponseChange(action._id, text)}
            platform={(action.platform as ActionPlatform) ?? undefined}
          />
        );
      }

      // Contact-based actions (eod_contact, new_connection)
      if (CONTACT_ACTION_TYPES.includes(action.type)) {
        return (
          <ContactCard
            personName={action.contactName ?? "New Contact"}
            createdAt={action.createdAt}
            platform={(action.platform as ActionPlatform) ?? undefined}
            formData={getContactFormData(action)}
            onFormChange={(data) => handleContactFormChange(action._id, data)}
          />
        );
      }

      // Fallback for unknown action types
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
    ],
  );

  // Get top action for button state
  const topAction = actions[0];

  // Loading state - show skeleton cards matching CardStack layout
  if (isLoading) {
    return <SkeletonStack />;
  }

  return (
    <ErrorBoundary>
      <View className="flex-1 bg-background pt-24">
        <CardStack
          actions={cardItems}
          totalCount={actions.length}
          onSwipe={handleSwipe}
          renderCard={renderCard}
          triggerSwipe={triggerSwipe}
        />

        {/* Bottom action buttons - positioned above tab bar */}
        {actions.length > 0 && (
          <View style={{ marginBottom: 56 + insets.bottom }}>
            <ActionButtons
              onSwipe={handleButtonSwipe}
              disabled={!topAction}
              skipLabel="Skip"
              sendLabel="Send"
            />
          </View>
        )}
      </View>
    </ErrorBoundary>
  );
}
