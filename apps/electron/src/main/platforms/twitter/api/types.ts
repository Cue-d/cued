/**
 * Twitter/X API types.
 * Based on mautrix/twitter (twittermeow) structures.
 */

export interface Cookie {
  name: string
  value: string
  domain?: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

export interface TwitterUser {
  id_str: string
  name: string
  screen_name: string
  profile_image_url_https?: string
  description?: string
}

export interface TwitterParticipant {
  user_id: string
  last_read_event_id?: string
  is_admin?: boolean
  join_time?: string
}

export type TwitterConversationType = 'ONE_TO_ONE' | 'GROUP_DM'

export interface TwitterConversation {
  conversation_id: string
  type: TwitterConversationType
  name?: string
  avatar_image_https?: string
  sort_timestamp?: string
  last_read_event_id?: string
  participants: TwitterParticipant[]
  trusted?: boolean
  low_quality?: boolean
  muted?: boolean
  status?: string
  min_entry_id?: string
  max_entry_id?: string
}

// ============================================================================
// Media / Attachment / Entity types (from mautrix entities.go)
// ============================================================================

export interface TwitterURL {
  url: string
  expanded_url: string
  display_url: string
  indices?: [number, number]
}

export interface TwitterUserMention {
  id_str: string
  name: string
  screen_name: string
  indices?: [number, number]
}

export interface TwitterVideoVariant {
  bitrate?: number
  url: string
  content_type: string
}

export interface TwitterVideoInfo {
  aspect_ratio?: [number, number]
  duration_millis?: number
  variants: TwitterVideoVariant[]
}

export interface TwitterOriginalInfo {
  url?: string
  width: number
  height: number
}

export interface TwitterMediaEntity {
  id_str: string
  media_url_https: string
  type: 'photo' | 'video' | 'animated_gif'
  original_info?: TwitterOriginalInfo
  video_info?: TwitterVideoInfo
  ext_alt_text?: string
  audio_only?: boolean
}

export interface TwitterEntities {
  urls?: TwitterURL[]
  user_mentions?: TwitterUserMention[]
  media?: TwitterMediaEntity[]
}

export interface TwitterAttachmentCard {
  binding_values?: {
    card_url?: { string_value: string }
    description?: { string_value: string }
    domain?: { string_value: string }
    title?: { string_value: string }
    vanity_url?: { string_value: string }
  }
}

export interface TwitterAttachmentTweet {
  display_url?: string
  expanded_url?: string
  status?: {
    full_text?: string
    user?: { name?: string; screen_name?: string }
  }
}

export interface TwitterAttachment {
  photo?: TwitterMediaEntity
  video?: TwitterMediaEntity
  animated_gif?: TwitterMediaEntity
  card?: TwitterAttachmentCard
  tweet?: TwitterAttachmentTweet
}

export interface TwitterReplyData {
  id: string
  time?: string
  sender_id?: string
  text?: string
}

export interface TwitterMessageData {
  id: string
  time?: string
  recipient_id?: string
  sender_id: string
  text?: string
  edit_count?: number
  entities?: TwitterEntities
  attachment?: TwitterAttachment
  reply_data?: TwitterReplyData
}

export interface TwitterMessageReaction {
  id: string
  time?: string
  conversation_id: string
  message_id: string
  reaction_key?: string
  emoji_reaction: string
  sender_id: string
}

export interface TwitterMessage {
  id: string
  time?: string
  request_id?: string
  conversation_id: string
  message_data: TwitterMessageData
  message_reactions?: TwitterMessageReaction[]
}

export interface TwitterConversationRead {
  id: string
  conversation_id: string
  last_read_event_id: string
}

export interface TwitterInboxTimeline {
  trusted?: { status?: string; min_entry_id?: string }
  untrusted?: { status?: string }
}

export interface TwitterInboxData {
  status?: string
  min_entry_id?: string
  max_entry_id?: string
  cursor?: string
  inbox_timelines?: TwitterInboxTimeline
  entries: Record<string, unknown>[]
  users: Record<string, TwitterUser>
  conversations: Record<string, TwitterConversation>
}

export interface InboxInitialStateResponse {
  inbox_initial_state?: TwitterInboxData
}

export interface GetDMUserUpdatesResponse {
  inbox_initial_state?: TwitterInboxData
  user_events?: TwitterInboxData
}

export interface AccountSettingsResponse {
  screen_name?: string
}

export interface TypeaheadUser {
  id_str: string
  screen_name: string
  name: string
  profile_image_url_https?: string
  verified?: boolean
  is_dm_able?: boolean
  is_blocked?: boolean
}

export interface TypeaheadSearchResponse {
  users: TypeaheadUser[]
}

export interface CachedSession {
  initializedAt: number
  lastSaved: number
  pollingCursor: string
  cacheVersion: number
  verificationToken: string
  animationToken: string
  country: string
  clientUUID: string
  bearerToken?: string
  variableIndexes?: [number, number, number, number]
}

// ============================================================================
// Event types (from mautrix event.go)
// ============================================================================

export interface TwitterMessageDelete {
  id: string
  time?: string
  conversation_id: string
  messages: { message_id: string }[]
}

export interface TwitterConversationCreate {
  id: string
  time?: string
  conversation_id: string
  request_id?: string
}

export interface TwitterParticipantsJoin {
  id: string
  time?: string
  conversation_id: string
  sender_id?: string
  participants: TwitterParticipant[]
}

export interface TwitterParticipantsLeave {
  id: string
  time?: string
  conversation_id: string
  participants: TwitterParticipant[]
}

export interface TwitterConversationNameUpdate {
  id: string
  time?: string
  conversation_id: string
  conversation_name: string
  by_user_id?: string
}

export interface TwitterTrustConversation {
  id: string
  time?: string
  conversation_id: string
  reason?: string
}

// ============================================================================
// GraphQL payload types (from mautrix payload)
// ============================================================================

export interface ReactionActionPayload {
  conversationId: string
  messageId: string
  reactionTypes: string[]
  emojiReactions: string[]
}

export interface DMMessageDeleteMutationVariables {
  messageId: string
  requestId?: string
}

export interface EditDirectMessagePayload {
  conversation_id: string
  request_id?: string
  dm_id: string
  text: string
}

export interface MarkConversationReadPayload {
  conversationId: string
  last_read_event_id: string
}

// ============================================================================
// TwitterEvent union + parser
// ============================================================================

export type TwitterEvent =
  | { type: 'message'; data: TwitterMessage }
  | { type: 'message_delete'; data: TwitterMessageDelete }
  | { type: 'message_edit'; data: TwitterMessage }
  | { type: 'reaction_create'; data: TwitterMessageReaction }
  | { type: 'reaction_delete'; data: TwitterMessageReaction }
  | { type: 'conversation_create'; data: TwitterConversationCreate }
  | { type: 'conversation_read'; data: TwitterConversationRead }
  | { type: 'conversation_name_update'; data: TwitterConversationNameUpdate }
  | { type: 'participants_join'; data: TwitterParticipantsJoin }
  | { type: 'participants_leave'; data: TwitterParticipantsLeave }
  | { type: 'trust_conversation'; data: TwitterTrustConversation }
  | { type: 'unknown'; raw: unknown }

/**
 * Parse a raw Twitter event container into a typed event.
 * Matches the mautrix twitterEventContainer field order.
 */
export function parseTwitterEvent(raw: unknown): TwitterEvent {
  if (!raw || typeof raw !== 'object') {
    return { type: 'unknown', raw }
  }

  const data = raw as Record<string, unknown>

  if (data.message && typeof data.message === 'object') {
    return { type: 'message', data: data.message as TwitterMessage }
  }

  if (data.message_delete && typeof data.message_delete === 'object') {
    return { type: 'message_delete', data: data.message_delete as TwitterMessageDelete }
  }

  if (data.message_edit && typeof data.message_edit === 'object') {
    return { type: 'message_edit', data: data.message_edit as TwitterMessage }
  }

  if (data.reaction_create && typeof data.reaction_create === 'object') {
    return { type: 'reaction_create', data: data.reaction_create as TwitterMessageReaction }
  }

  if (data.reaction_delete && typeof data.reaction_delete === 'object') {
    return { type: 'reaction_delete', data: data.reaction_delete as TwitterMessageReaction }
  }

  if (data.conversation_create && typeof data.conversation_create === 'object') {
    return { type: 'conversation_create', data: data.conversation_create as TwitterConversationCreate }
  }

  // mautrix also handles "remove_conversation", "join_conversation", and "conversation_avatar_update"
  // — these are uncommon events that fall through to 'unknown' here

  if (data.participants_join && typeof data.participants_join === 'object') {
    return { type: 'participants_join', data: data.participants_join as TwitterParticipantsJoin }
  }

  if (data.participants_leave && typeof data.participants_leave === 'object') {
    return { type: 'participants_leave', data: data.participants_leave as TwitterParticipantsLeave }
  }

  if (data.conversation_name_update && typeof data.conversation_name_update === 'object') {
    return { type: 'conversation_name_update', data: data.conversation_name_update as TwitterConversationNameUpdate }
  }

  if (data.conversation_read && typeof data.conversation_read === 'object') {
    return { type: 'conversation_read', data: data.conversation_read as TwitterConversationRead }
  }

  if (data.trust_conversation && typeof data.trust_conversation === 'object') {
    return { type: 'trust_conversation', data: data.trust_conversation as TwitterTrustConversation }
  }

  return { type: 'unknown', raw }
}

export interface DMRequestQuery {
  active_conversation_id?: string
  cursor?: string
  count?: number
  context?: 'FETCH_DM_CONVERSATION' | 'FETCH_DM_CONVERSATION_HISTORY'
  max_id?: string
  min_id?: string
  include_conversation_info?: boolean
  nsfw_filtering_enabled: boolean
  filter_low_quality: boolean
  include_quality: string
  include_profile_interstitial_type: number
  include_blocking: number
  include_blocked_by: number
  include_followed_by: number
  include_want_retweets: number
  include_mute_edge: number
  include_can_dm: number
  include_can_media_tag: number
  include_ext_is_blue_verified: number
  include_ext_verified_type: number
  include_ext_profile_image_shape: number
  skip_status: number
  dm_secret_conversations_enabled: boolean
  krs_registration_enabled: boolean
  cards_platform: string
  include_cards: number
  include_ext_alt_text: boolean
  include_ext_limited_action_results: boolean
  include_quote_count: boolean
  include_reply_count: number
  tweet_mode: string
  include_ext_views: boolean
  dm_users: boolean
  include_groups: boolean
  include_inbox_timelines: boolean
  include_ext_media_color: boolean
  supports_reactions: boolean
  supports_edit: boolean
  include_ext_edit_control: boolean
  include_ext_business_affiliations_label: boolean
  include_ext_parody_commentary_fan_label: boolean
  ext: string
}

export function defaultDMRequestQuery(): DMRequestQuery {
  return {
    nsfw_filtering_enabled: false,
    filter_low_quality: true,
    include_quality: 'all',
    include_profile_interstitial_type: 1,
    include_blocking: 1,
    include_blocked_by: 1,
    include_followed_by: 1,
    include_want_retweets: 1,
    include_mute_edge: 1,
    include_can_dm: 1,
    include_can_media_tag: 1,
    include_ext_is_blue_verified: 1,
    include_ext_verified_type: 1,
    include_ext_profile_image_shape: 1,
    skip_status: 1,
    dm_secret_conversations_enabled: false,
    krs_registration_enabled: false,
    cards_platform: 'Web-12',
    include_cards: 1,
    include_ext_alt_text: true,
    include_ext_limited_action_results: true,
    include_quote_count: true,
    include_reply_count: 1,
    tweet_mode: 'extended',
    include_ext_views: true,
    dm_users: true,
    include_groups: true,
    include_inbox_timelines: true,
    include_ext_media_color: true,
    supports_reactions: true,
    supports_edit: true,
    include_ext_edit_control: true,
    include_ext_business_affiliations_label: true,
    include_ext_parody_commentary_fan_label: true,
    ext: 'mediaColor,altText,businessAffiliationsLabel,mediaStats,highlightedLabel,parodyCommentaryFanLabel,voiceInfo,birdwatchPivot,superFollowMetadata,unmentionInfo,editControl,article',
  }
}

export interface DMSendQuery {
  ext: string
  include_ext_alt_text: boolean
  include_ext_limited_action_results: boolean
  include_reply_count: number
  tweet_mode: string
  include_ext_views: boolean
  include_groups: boolean
  include_inbox_timelines: boolean
  include_ext_media_color: boolean
  supports_reactions: boolean
  supports_edit: boolean
}

export function defaultDMSendQuery(): DMSendQuery {
  return {
    ext: 'mediaColor,altText,mediaStats,highlightedLabel,voiceInfo,birdwatchPivot,superFollowMetadata,unmentionInfo,editControl,article',
    include_ext_alt_text: true,
    include_ext_limited_action_results: true,
    include_reply_count: 1,
    tweet_mode: 'extended',
    include_ext_views: true,
    include_groups: true,
    include_inbox_timelines: true,
    include_ext_media_color: true,
    supports_reactions: true,
    supports_edit: true,
  }
}

export interface SendDirectMessagePayload {
  conversation_id: string
  text: string
  request_id: string
  recipient_ids: boolean
  dm_users: boolean
  cards_platform: string
  include_cards: number
  include_quote_count: boolean
  audio_only_media_attachment: boolean
  media_id?: string
  reply_to_dm_id?: string
}
