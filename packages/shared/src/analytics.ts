/**
 * Analytics event definitions for PostHog tracking.
 * All custom events follow {domain}_{action} snake_case convention.
 */

// Sync events
export const ANALYTICS_EVENTS = {
  // Sync
  SYNC_STARTED: "sync_started",
  SYNC_COMPLETED: "sync_completed",
  SYNC_FAILED: "sync_failed",

  // Action queue
  ACTION_VIEWED: "action_viewed",
  ACTION_APPROVED: "action_approved",
  ACTION_DISMISSED: "action_dismissed",
  ACTION_SWIPED: "action_swiped",

  // AI assistant
  ASSISTANT_MESSAGE_SENT: "assistant_message_sent",
  ASSISTANT_TOOL_INVOKED: "assistant_tool_invoked",
  ASSISTANT_CONVERSATION_STARTED: "assistant_conversation_started",

  // Contacts
  CONTACT_VIEWED: "contact_viewed",
  CONTACT_EDITED: "contact_edited",
  CONTACT_MERGED: "contact_merged",
} as const

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS]

export interface SyncStartedProperties {
  platform: string
  sync_mode: string
}

export interface SyncCompletedProperties {
  platform: string
  messages_synced: number
  contacts_synced: number
  duration_ms: number
}

export interface SyncFailedProperties {
  platform: string
  error_type: string
  error_message: string
}

export interface ActionEventProperties {
  action_type: string
  platform?: string
  direction?: string
}

export interface AssistantMessageProperties {
  message_length: number
}

export interface AssistantToolProperties {
  tool_name: string
}

export interface ContactViewedProperties {
  contact_id: string
  source: string
}

export interface ContactEditedProperties {
  fields_changed: string[]
}

export interface ContactMergedProperties {
  contact_count: number
}
