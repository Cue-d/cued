/**
 * Types for action card rendering.
 */

import type { EnrichedAction, DisplayMessage, ContactHandle } from "@cued/shared";

/**
 * Context data for the top action card.
 * This is the full context fetched from getActionWithContext.
 */
export interface ActionContext {
  /** The action data */
  action: {
    _id: string;
    type: string;
    status: string;
    priority: number;
    reason: string | null;
    llmReason: string | null;
    createdAt: number;
    snoozedUntil: number | null;
    completedAt: number | null;
    discardedAt: number | null;
    platform: string | null;
    secondaryContactId: string | null;
    mergeSuggestionId: string | null;
  };
  /** Related conversation */
  conversation: {
    _id: string;
    platform: string;
    conversationType: string;
    displayName: string | null;
    lastMessageAt: number | null;
  } | null;
  /** Primary contact */
  contact: {
    _id: string;
    displayName: string;
    company: string | null;
    notes: string | null;
    importance: number | null;
    handles: Array<{
      handleType: string;
      handle: string;
      platform: string;
    }>;
  } | null;
  /** Secondary contact (for merge actions) */
  secondaryContact: {
    _id: string;
    displayName: string;
    company: string | null;
    notes: string | null;
    importance: number | null;
    handles: Array<{
      handleType: string;
      handle: string;
      platform: string;
    }>;
  } | null;
  /** Recent messages */
  messages: Array<{
    _id: string;
    content: string | null;
    sentAt: number;
    isFromMe: boolean;
    senderName: string | null;
    status: string | null;
    reactions: Array<{ emoji: string }> | null;
  }>;
}

/**
 * Props passed to action card components.
 */
export interface ActionCardProps {
  /** The enriched action data */
  action: EnrichedAction;
  /** Whether this is the top card in the stack */
  isTop: boolean;
  /** Full context (only available for top card) */
  context?: ActionContext | null;
  /** Current response text (for message actions) */
  responseText: string;
  /** Called when response text changes */
  onResponseChange: (text: string) => void;
  /** Called when user triggers send */
  onSend?: () => void;
  /** Called when user dismisses the action */
  onDismiss?: () => void;
  /** Whether a send is in progress */
  isSending?: boolean;
  /** Whether to auto-focus input */
  autoFocus: boolean;
  /** Optional className */
  className?: string;
}

/**
 * Card component type for the registry.
 */
export type ActionCardComponent = React.ComponentType<ActionCardProps>;
