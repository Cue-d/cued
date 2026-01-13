/**
 * Types for the unified inbox components.
 * These mirror the Convex query return types from packages/convex/convex/messages.ts
 */

export type Platform = "imessage" | "gmail" | "slack"
export type ConversationType = "dm" | "group" | "channel"

export interface Participant {
  _id: string
  displayName: string
}

export interface Conversation {
  _id: string
  platform: Platform
  platformConversationId: string
  conversationType: ConversationType
  participants: Participant[]
  lastMessageText: string | null
  lastMessageAt: number | null
  unreadCount: number
}

export interface InboxResult {
  conversations: Conversation[]
  nextCursor: string | null
}
