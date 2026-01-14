/**
 * Types for message thread components.
 * These mirror the Convex query return types from packages/convex/convex/messages.ts
 */

import type { Platform } from "./types"

export interface MessageSender {
  _id: string
  displayName: string
}

export interface MessageAttachment {
  filename: string
  mimeType: string
  size: number
  url: string
  thumbnailUrl: string | null
}

export interface Message {
  _id: string
  content: string
  sentAt: number
  isFromMe: boolean
  platform: Platform
  sender: MessageSender | null
  attachments?: MessageAttachment[]
}

export interface MessagesResult {
  messages: Message[]
  nextCursor: string | null
}
