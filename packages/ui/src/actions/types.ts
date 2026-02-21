/**
 * Types for action card rendering.
 */

import type { EnrichedAction, ReactionGroup } from "@cued/shared";

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
    summary?: string | null;
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
    platformConversationId: string;
    conversationType: string;
    displayName: string | null;
    lastMessageAt: number | null;
    workspaceId: string | null;
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
  /** Conversation participants with their platform info */
  participants: Array<{
    _id: string;
    displayName: string;
    platforms: string[];
  }>;
  /** Recent messages */
  messages: Array<{
    _id: string;
    content: string | null;
    sentAt: number;
    isFromMe: boolean;
    senderName: string | null;
    senderContactId: string | null;
    status: string | null;
    reactions: ReactionGroup[] | null;
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
  /** When true, hides response input and action buttons (history view) */
  readOnly?: boolean;
  /** Optional className */
  className?: string;
  /** Open-in-app deeplink config */
  openInApp?: OpenInAppConfig | null;
  /** Per-contact open-in-app config for resolve_contact (contact 1) */
  contact1OpenInApp?: OpenInAppConfig | null;
  /** Per-contact open-in-app config for resolve_contact (contact 2) */
  contact2OpenInApp?: OpenInAppConfig | null;
  /** Called when a link in a message is clicked. Receives the URL. */
  onLinkClick?: (url: string) => void;
  /** Called when a contact name is clicked. Receives the contact ID. */
  onContactClick?: (contactId: string) => void;
  /** Whether there are older messages to load */
  hasMore?: boolean;
  /** Called when user wants to load older messages */
  onLoadMore?: () => void;
  /** Whether older messages are currently loading */
  isLoadingMore?: boolean;
}

/** Open-in-app config for deeplink buttons */
export interface OpenInAppConfig {
  onOpenInApp?: () => void;
  label?: string | null;
  icon?: React.ReactNode;
  disabledReason?: string | null;
}

/**
 * Card component type for the registry.
 */
export type ActionCardComponent = React.ComponentType<ActionCardProps>;
