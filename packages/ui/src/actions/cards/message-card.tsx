/**
 * Message card wrapper for respond, follow_up, send_message actions.
 * Delegates to MessageResponseCard with context mapping.
 */

import * as React from "react";
import { MessageResponseCard } from "../../components/action-queue/message-response-card";
import type { ActionCardProps } from "../types";
import type { DisplayMessage } from "@cued/shared";

/**
 * Message card for respond/follow_up/send_message actions.
 */
export function MessageCard({
  action,
  isTop,
  context,
  responseText,
  onResponseChange,
  onSend,
  onDismiss,
  isSending,
  autoFocus,
  className,
}: ActionCardProps) {
  // For top card with context, render with full data
  if (isTop && context) {
    const { contact, conversation, messages } = context;

    // For groups/channels, use conversation displayName; for DMs use contact
    const isGroup = conversation?.conversationType !== "dm";
    const personName = isGroup
      ? conversation?.displayName ?? action.contactName ?? "Group Chat"
      : contact?.displayName ?? action.contactName ?? "Unknown";

    // Map messages to DisplayMessage format
    const displayMessages: DisplayMessage[] = messages.map((msg) => ({
      _id: msg._id,
      content: msg.content,
      sentAt: msg.sentAt,
      isFromMe: msg.isFromMe,
      senderName: msg.senderName,
      status: msg.status,
      reactions: msg.reactions?.map((r) => r.emoji) ?? null,
    }));

    // Get message timestamp from latest non-self message
    const latestReceivedMsg = [...messages].reverse().find((m) => !m.isFromMe);
    const messageTimestamp = latestReceivedMsg?.sentAt;

    return (
      <MessageResponseCard
        personName={personName}
        messageTimestamp={messageTimestamp}
        messages={displayMessages}
        responseText={responseText}
        onResponseChange={onResponseChange}
        onSend={onSend}
        onDismiss={onDismiss}
        isSending={isSending}
        autoFocus={autoFocus}
        className={className}
      />
    );
  }

  // Minimal view for non-top cards or while loading context
  return (
    <MessageResponseCard
      personName={action.contactName ?? "Unknown"}
      messages={[]}
      responseText={responseText}
      onResponseChange={onResponseChange}
      onSend={onSend}
      onDismiss={onDismiss}
      isSending={isSending}
      autoFocus={false}
      className={className}
    />
  );
}

// Export specific card types that use the same component
export const RespondCard = MessageCard;
export const FollowUpCard = MessageCard;
export const SendMessageCard = MessageCard;
