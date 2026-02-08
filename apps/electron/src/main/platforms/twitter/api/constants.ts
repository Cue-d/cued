/**
 * Twitter/X API constants.
 * Based on the mautrix/twitter (twittermeow) Go implementation.
 */

export const TWITTER_BASE_HOST = 'twitter.com'
export const TWITTER_BASE_URL = `https://${TWITTER_BASE_HOST}`

export const BASE_HOST = 'x.com'
export const BASE_URL = `https://${BASE_HOST}`
export const BASE_LOGIN_URL = `${BASE_URL}/login`
export const BASE_MESSAGES_URL = `${BASE_URL}/messages`
export const BASE_LOGOUT_URL = `${BASE_URL}/logout`

export const API_URLS = {
  // Inbox / messages
  accountSettings: `${BASE_URL}/i/api/1.1/account/settings.json`,
  inboxInitialState: `${BASE_URL}/i/api/1.1/dm/inbox_initial_state.json`,
  dmUserUpdates: `${BASE_URL}/i/api/1.1/dm/user_updates.json`,
  conversationFetchMessages: `${BASE_URL}/i/api/1.1/dm/conversation/%s.json`,
  trustedInboxTimeline: `${BASE_URL}/i/api/1.1/dm/inbox_timeline/trusted.json`,
  sendDM: `${BASE_URL}/i/api/1.1/dm/new2.json`,
  editDM: `${BASE_URL}/i/api/1.1/dm/edit.json`,
  searchTypeahead: `${BASE_URL}/i/api/1.1/search/typeahead.json`,

  // Conversation management
  conversationMarkRead: `${BASE_URL}/i/api/1.1/dm/conversation/%s/mark_read.json`,
  acceptConversation: `${BASE_URL}/i/api/1.1/dm/conversation/%s/accept.json`,
  deleteConversation: `${BASE_URL}/i/api/1.1/dm/conversation/%s/delete.json`,
  updateConversationName: `${BASE_URL}/i/api/1.1/dm/conversation/%s/update_name.json`,
  updateConversationAvatar: `${BASE_URL}/i/api/1.1/dm/conversation/%s/update_avatar.json`,

  // GraphQL mutations
  graphqlDeleteMessage: `${BASE_URL}/i/api/graphql/BJ6DtxA2llfjnRoRjaiIiw/DMMessageDeleteMutation`,
  graphqlPinConversation: `${BASE_URL}/i/api/graphql/o0aymgGiJY-53Y52YSUGVA/DMPinnedInboxAppend_Mutation`,
  graphqlUnpinConversation: `${BASE_URL}/i/api/graphql/_TQxP2Rb0expwVP9ktGrTQ/DMPinnedInboxDelete_Mutation`,
  graphqlAddReaction: `${BASE_URL}/i/api/graphql/VyDyV9pC2oZEj6g52hgnhA/useDMReactionMutationAddMutation`,
  graphqlRemoveReaction: `${BASE_URL}/i/api/graphql/bV_Nim3RYHsaJwMkTXJ6ew/useDMReactionMutationRemoveMutation`,
  graphqlTypingNotification: `${BASE_URL}/i/api/graphql/HL96-xZ3Y81IEzAdczDokg/useTypingNotifierMutation`,
  graphqlAddParticipants: `${BASE_URL}/i/api/graphql/oBwyQ0_xVbAQ8FAyG0pCRA/AddParticipantsMutation`,

  // SSE streaming
  pipelineEvents: 'https://api.x.com/live_pipeline/events',
  pipelineUpdateSubscriptions: 'https://api.x.com/1.1/live_pipeline/update_subscriptions',
} as const

export const COOKIE_NAMES = {
  authToken: 'auth_token',
  csrfToken: 'ct0',
  guestToken: 'gt',
  twid: 'twid',
} as const

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

export const BASE_HEADERS: Record<string, string> = {
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': USER_AGENT,
  'Sec-Ch-Ua': '"Chromium";v="141", "Google Chrome";v="141", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Ch-Ua-Mobile': '?0',
  Referer: `${BASE_URL}/`,
  Origin: BASE_URL,
}

/**
 * Hardcoded fallback bearer token from the X web client.
 * May rotate; the client also attempts to parse a fresh one from main script.
 */
export const DEFAULT_BEARER_TOKEN =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'

export const RETRY_CONFIG = {
  maxRetries: 5,
  baseDelayMs: 3000,
  retryableStatusCodes: [429, 500, 502, 503, 504],
  authErrorStatusCodes: [401, 403],
} as const

export const CURRENT_CACHE_VERSION = 1

/**
 * GraphQL query IDs from the X web client.
 * These are hardcoded in the client JS bundle and may rotate on deployments.
 */
export const GRAPHQL_QUERY_IDS = {
  deleteMessage: 'BJ6DtxA2llfjnRoRjaiIiw',
  addReaction: 'VyDyV9pC2oZEj6g52hgnhA',
  removeReaction: 'bV_Nim3RYHsaJwMkTXJ6ew',
  typingNotification: 'HL96-xZ3Y81IEzAdczDokg',
} as const
