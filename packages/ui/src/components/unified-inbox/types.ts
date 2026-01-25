/**
 * Types for the unified inbox components.
 * These mirror the Convex query return types from packages/convex/convex/messages.ts
 */

import type { ActionPlatform } from "@prm/shared"

/** Platform type for inbox - re-exported from shared for convenience */
export type InboxPlatform = ActionPlatform
export type InboxConversationType = "dm" | "group" | "channel"

export interface InboxParticipant {
  _id: string
  displayName: string
  /** Platform-specific handle for sending (e.g., phone number for iMessage) */
  handle?: string
}

export interface InboxConversation {
  _id: string
  platform: InboxPlatform
  platformConversationId: string
  conversationType: InboxConversationType
  displayName: string | null
  participants: InboxParticipant[]
  lastMessageText: string | null
  lastMessageAt: number | null
  unreadCount: number
  /** For multi-workspace platforms (Slack teamId, Gmail email address) */
  workspaceId: string | null
}

export interface InboxResult {
  conversations: InboxConversation[]
  nextCursor: string | null
}
