/**
 * Types for message thread components.
 * These mirror the Convex query return types from packages/convex/convex/messages.ts
 */

import type { InboxPlatform } from "./types"

export interface InboxMessageSender {
  _id: string
  displayName: string
}

export interface InboxMessageAttachment {
  filename: string
  mimeType: string
  size: number
  url: string
  thumbnailUrl: string | null
}

export interface InboxMessage {
  _id: string
  content: string
  sentAt: number
  isFromMe: boolean
  platform: InboxPlatform
  sender: InboxMessageSender | null
  attachments?: InboxMessageAttachment[]
}

export interface InboxMessagesResult {
  messages: InboxMessage[]
  nextCursor: string | null
}
