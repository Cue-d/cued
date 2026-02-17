/**
 * Message card wrapper for respond, follow_up, send_message actions.
 * Delegates to MessageResponseCard with context mapping.
 */

import * as React from "react";
import { MessageResponseCard } from "../../components/action-queue/message-response-card";
import type { ActionCardProps } from "../types";
import type { DisplayMessage, ActionPlatform } from "@cued/shared";

function normalizeReactions(
  reactions:
    | Array<{ emoji?: string; name?: string; reaction?: string }>
    | string[]
    | null
    | undefined
): string[] | null {
  if (!reactions || reactions.length === 0) return null;

  const normalizeToken = (token: string): string => {
    const trimmed = token.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith(":") && trimmed.endsWith(":")) return trimmed;
    if (/^[a-z0-9_+-]+$/i.test(trimmed)) return `:${trimmed}:`;
    return trimmed;
  };

  if (typeof reactions[0] === "string") {
    return (reactions as string[])
      .map((emoji) => normalizeToken(emoji))
      .filter(
      (emoji): emoji is string => typeof emoji === "string" && emoji.length > 0
    );
  }

  return (reactions as Array<{ emoji?: string; name?: string; reaction?: string }>)
    .map((reaction) => {
      const raw = reaction?.emoji ?? reaction?.name ?? reaction?.reaction;
      return typeof raw === "string" ? normalizeToken(raw) : "";
    })
    .filter((emoji): emoji is string => typeof emoji === "string" && emoji.length > 0);
}

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
  openInApp,
  onLinkClick,
  onContactClick,
  hasMore,
  onLoadMore,
  isLoadingMore,
  readOnly,
}: ActionCardProps) {
  // For top card with context, render with full data
  if (isTop && context) {
    const { contact, conversation, messages, participants } = context;
    const platform = (action.platform ?? conversation?.platform ?? null) as ActionPlatform | null;

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
      senderContactId: msg.senderContactId,
      status: msg.status,
      reactions: normalizeReactions(msg.reactions),
    }));

    // Get message timestamp from latest non-self message
    const latestReceivedMsg = [...messages].reverse().find((m) => !m.isFromMe);
    const messageTimestamp = latestReceivedMsg?.sentAt;

    return (
      <MessageResponseCard
        personName={personName}
        messageTimestamp={messageTimestamp}
        messages={displayMessages}
        responseText={readOnly ? "" : responseText}
        onResponseChange={readOnly ? () => {} : onResponseChange}
        onSend={readOnly ? undefined : onSend}
        onDismiss={readOnly ? undefined : onDismiss}
        isSending={isSending}
        autoFocus={readOnly ? false : autoFocus}
        className={className}
        platform={platform ?? undefined}
        openInApp={openInApp}
        onLinkClick={onLinkClick}
        participants={participants}
        contactId={contact?._id}
        onContactClick={onContactClick}
        hasMore={hasMore}
        onLoadMore={onLoadMore}
        isLoadingMore={isLoadingMore}
        readOnly={readOnly}
        resolvedAt={action.completedAt ?? action.discardedAt}
        resolvedStatus={action.status === "discarded" ? "discarded" : action.status === "completed" ? "completed" : null}
      />
    );
  }

  // Minimal view for non-top cards or while loading context
  return (
    <MessageResponseCard
      personName={action.contactName ?? "Unknown"}
      messages={[]}
      responseText={readOnly ? "" : responseText}
      onResponseChange={readOnly ? () => {} : onResponseChange}
      onSend={readOnly ? undefined : onSend}
      onDismiss={readOnly ? undefined : onDismiss}
      isSending={isSending}
      autoFocus={false}
      className={className}
      platform={(action.platform as ActionPlatform | null) ?? undefined}
      openInApp={openInApp}
      onLinkClick={onLinkClick}
      contactId={action.contactId}
      onContactClick={onContactClick}
      readOnly={readOnly}
      resolvedAt={action.completedAt ?? action.discardedAt}
      resolvedStatus={action.status === "discarded" ? "discarded" : action.status === "completed" ? "completed" : null}
    />
  );
}

// Export specific card types that use the same component
export const RespondCard = MessageCard;
export const FollowUpCard = MessageCard;
export const SendMessageCard = MessageCard;
