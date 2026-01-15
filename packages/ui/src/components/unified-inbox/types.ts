/**
 * Types for the unified inbox components.
 * These mirror the Convex query return types from packages/convex/convex/messages.ts
 */

export type InboxPlatform = "imessage" | "gmail" | "slack"
export type InboxConversationType = "dm" | "group" | "channel"

export interface InboxParticipant {
  _id: string
  displayName: string
}

export interface InboxConversation {
  _id: string
  platform: InboxPlatform
  platformConversationId: string
  conversationType: InboxConversationType
  participants: InboxParticipant[]
  lastMessageText: string | null
  lastMessageAt: number | null
  unreadCount: number
}

export interface InboxResult {
  conversations: InboxConversation[]
  nextCursor: string | null
}
