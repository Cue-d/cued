/**
 * Slack API Types
 * Based on Slack Web API and RTM API schemas
 */

// ============================================================================
// Authentication
// ============================================================================

export interface SlackCredentials {
  token: string // xoxc- browser session token
  cookie: string // d cookie value
}

export interface SlackAuthTestResponse {
  ok: boolean
  error?: string
  url?: string
  team?: string
  user?: string
  team_id?: string
  user_id?: string
  bot_id?: string
  is_enterprise_install?: boolean
}

// ============================================================================
// Users
// ============================================================================

export interface SlackUser {
  id: string
  team_id: string
  name: string
  deleted?: boolean
  color?: string
  real_name?: string
  tz?: string
  tz_label?: string
  tz_offset?: number
  profile: SlackUserProfile
  is_admin?: boolean
  is_owner?: boolean
  is_primary_owner?: boolean
  is_restricted?: boolean
  is_ultra_restricted?: boolean
  is_bot?: boolean
  is_app_user?: boolean
  updated?: number
}

export interface SlackUserProfile {
  title?: string
  phone?: string
  skype?: string
  real_name?: string
  real_name_normalized?: string
  display_name?: string
  display_name_normalized?: string
  status_text?: string
  status_emoji?: string
  status_expiration?: number
  avatar_hash?: string
  email?: string
  first_name?: string
  last_name?: string
  image_24?: string
  image_32?: string
  image_48?: string
  image_72?: string
  image_192?: string
  image_512?: string
  image_original?: string
  team?: string
}

export interface SlackUsersInfoResponse {
  ok: boolean
  error?: string
  user?: SlackUser
}

// ============================================================================
// Conversations (Channels, DMs, Groups)
// ============================================================================

export interface SlackConversation {
  id: string
  name?: string
  is_channel?: boolean
  is_group?: boolean
  is_im?: boolean
  is_mpim?: boolean
  is_private?: boolean
  is_archived?: boolean
  is_general?: boolean
  is_shared?: boolean
  is_org_shared?: boolean
  is_ext_shared?: boolean
  is_pending_ext_shared?: boolean
  is_member?: boolean
  created?: number
  creator?: string
  unlinked?: number
  name_normalized?: string
  num_members?: number
  topic?: SlackTopic
  purpose?: SlackTopic
  previous_names?: string[]
  user?: string // For IMs, the user ID of the other party
  last_read?: string
  unread_count?: number
  unread_count_display?: number
  latest?: SlackMessage
  priority?: number
}

export interface SlackTopic {
  value: string
  creator: string
  last_set: number
}

export interface SlackConversationsListResponse {
  ok: boolean
  error?: string
  channels?: SlackConversation[]
  response_metadata?: {
    next_cursor?: string
  }
}

export interface SlackConversationsHistoryResponse {
  ok: boolean
  error?: string
  messages?: SlackMessage[]
  has_more?: boolean
  pin_count?: number
  channel_actions_ts?: string
  response_metadata?: {
    next_cursor?: string
  }
}

export interface SlackConversationsRepliesResponse {
  ok: boolean
  error?: string
  messages?: SlackMessage[]
  has_more?: boolean
  response_metadata?: {
    next_cursor?: string
  }
}

export interface SlackConversationsMembersResponse {
  ok: boolean
  error?: string
  members?: string[]
  response_metadata?: {
    next_cursor?: string
  }
}

// ============================================================================
// Messages
// ============================================================================

export interface SlackMessage {
  type: string
  subtype?: string
  user?: string
  bot_id?: string
  text: string
  ts: string // Timestamp (also used as message ID)
  thread_ts?: string // If this is a thread reply, the parent message ts
  reply_count?: number
  reply_users_count?: number
  latest_reply?: string
  reply_users?: string[]
  is_locked?: boolean
  subscribed?: boolean
  reactions?: SlackReaction[]
  attachments?: SlackAttachment[]
  blocks?: SlackBlock[]
  files?: SlackFile[]
  edited?: {
    user: string
    ts: string
  }
}

export interface SlackReaction {
  name: string
  count: number
  users: string[]
}

export interface SlackAttachment {
  id?: number
  fallback?: string
  color?: string
  pretext?: string
  author_name?: string
  author_link?: string
  author_icon?: string
  title?: string
  title_link?: string
  text?: string
  fields?: SlackAttachmentField[]
  image_url?: string
  thumb_url?: string
  footer?: string
  footer_icon?: string
  ts?: string | number
}

export interface SlackAttachmentField {
  title: string
  value: string
  short?: boolean
}

export interface SlackBlock {
  type: string
  block_id?: string
  elements?: unknown[]
  text?: unknown
  accessory?: unknown
}

export interface SlackFile {
  id: string
  name: string
  title: string
  mimetype: string
  filetype: string
  pretty_type: string
  user: string
  mode: string
  editable: boolean
  is_external: boolean
  external_type?: string
  size: number
  url_private?: string
  url_private_download?: string
  thumb_64?: string
  thumb_80?: string
  thumb_360?: string
  thumb_360_w?: number
  thumb_360_h?: number
  thumb_480?: string
  thumb_160?: string
  permalink: string
  permalink_public?: string
  created: number
  timestamp: number
}

// ============================================================================
// Posting Messages
// ============================================================================

export interface SlackPostMessageRequest {
  channel: string
  text?: string
  blocks?: SlackBlock[]
  thread_ts?: string // To reply in a thread
  reply_broadcast?: boolean // Also post to channel when replying in thread
  unfurl_links?: boolean
  unfurl_media?: boolean
}

export interface SlackPostMessageResponse {
  ok: boolean
  error?: string
  channel?: string
  ts?: string
  message?: SlackMessage
}

// ============================================================================
// Error Types
// ============================================================================

export interface SlackErrorResponse {
  ok: false
  error: string
  response_metadata?: {
    messages?: string[]
  }
}
