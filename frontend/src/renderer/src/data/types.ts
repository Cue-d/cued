// Frontend-specific chat types (for legacy chat view)
export interface Message {
  id: string
  text: string
  isSent: boolean
  isRead: boolean
  timestamp: Date
  isLink?: boolean
  senderName?: string | null
}

export interface Chat {
  id: string
  name: string
  avatar?: string
  initials?: string
  isGroup?: boolean
  groupAvatars?: string[]
  lastMessage: string
  timestamp: Date
  messages: Message[]
}

// Action Queue Types - derived from API types in preload/index.d.ts
// Re-export the canonical types
export type { ActionResponse, SearchResultResponse, SwipeRequest } from '../../../preload/index.d'

// Convenience type aliases for the action system
export type ActionType = 'respond_to_message' | 'eod_contact' | 'follow_up'
export type SwipeDirection = 'left' | 'right' | 'up'

export const formatTimestamp = (date: Date): string => {
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (days === 0) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } else if (days === 1) {
    return 'Yesterday'
  } else if (days < 7) {
    return date.toLocaleDateString([], { weekday: 'short' })
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export const formatMessageTime = (date: Date): string => {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export const formatDateDivider = (date: Date): string => {
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}
