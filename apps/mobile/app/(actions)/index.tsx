/**
 * Actions tab main screen.
 *
 * Task 7.1: Implement Actions tab with CardStack and real data.
 * Task 7.2: Implement swipe handler with Convex mutation.
 * Task 7.4: Wire snooze picker to action swipe.
 * Displays pending actions as swipeable cards using Convex data.
 */

import { useState, useCallback, useEffect } from "react";
import { useMutation } from "convex/react";
import { useRouter, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { View, Text, ScrollView } from "@/tw";
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
  const params = useLocalSearchParams<{
    snoozedUntil?: string;
    snoozeActionId?: string;
  }>();
  const { actions, isLoading } = useActions({ limit: 20 });
  const swipeAction = useMutation(api.actions.swipeAction);

  // Track response text per action (key = action._id)
  const [responseTexts, setResponseTexts] = useState<Record<string, string>>(
    {},
  );

  // Track contact form data per action (key = action._id)
  const [contactForms, setContactForms] = useState<
    Record<string, ContactFormData>
  >({});

  // Handle snooze return from snooze-picker sheet
  useEffect(() => {
    const handleSnoozeReturn = async () => {
      const { snoozedUntil, snoozeActionId } = params;
      if (!snoozedUntil || !snoozeActionId) return;

      const timestamp = parseInt(snoozedUntil, 10);
      if (isNaN(timestamp)) return;

      try {
        await swipeAction({
          actionId: snoozeActionId as Id<"actions">,
          direction: "up",
          snoozedUntil: timestamp,
        });
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (error) {
        console.error("Failed to snooze action:", error);
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }

      // Clear params after processing
      router.setParams({ snoozedUntil: undefined, snoozeActionId: undefined });
    };

    handleSnoozeReturn();
  }, [params, swipeAction, router]);

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

      // For snooze (up), navigate to snooze picker sheet
      if (direction === "up") {
        router.push({
          pathname: "/(actions)/snooze-picker",
          params: { actionId: action._id },
        });
        return;
      }

      // Get response text for right swipe (send)
      const responseText =
        direction === "right" ? getResponseText(action) : undefined;

      // Get notes from contact form for new_connection right swipe
      const notes =
        direction === "right" && action.type === "new_connection"
          ? getContactFormData(action).notes
          : undefined;

      try {
        await swipeAction({
          actionId: action._id as Id<"actions">,
          direction,
          responseText: notes ?? responseText,
        });
        // Success haptic feedback
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (error) {
        console.error("Failed to swipe action:", error);
        // Error haptic feedback
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    },
    [router, swipeAction, getResponseText, getContactFormData],
  );

  // Render card based on action type
  const renderCard = useCallback(
    (item: ActionItem): React.JSX.Element => {
      const { action } = item;

      // Message-based actions (respond, follow_up)
      if (MESSAGE_ACTION_TYPES.includes(action.type)) {
        // For now, render with minimal data
        // Task 7.5 will add getActionWithContext for full messages
        const messages: DisplayMessage[] = [];

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
          <Text className="text-sf-label text-lg font-semibold">
            {action.type}
          </Text>
          <Text className="text-sf-secondaryLabel text-sm mt-2">
            {action.contactName ?? "Unknown contact"}
          </Text>
          {action.reason && (
            <Text className="text-sf-tertiaryLabel text-xs mt-1 text-center">
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
    ],
  );

  // Loading state
  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center">
        <Text className="text-sf-secondaryLabel">Loading actions...</Text>
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="flex-1"
    >
      <CardStack
        actions={cardItems}
        totalCount={actions.length}
        onSwipe={handleSwipe}
        renderCard={renderCard}
      />
    </ScrollView>
  );
}
