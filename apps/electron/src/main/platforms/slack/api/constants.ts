/**
 * Slack API Constants
 */

// ============================================================================
// API URLs
// ============================================================================

export const SLACK_API_BASE = 'https://slack.com/api'

export const SLACK_API_URLS = {
  // Auth
  authTest: `${SLACK_API_BASE}/auth.test`,

  // Users
  usersInfo: `${SLACK_API_BASE}/users.info`,
  usersList: `${SLACK_API_BASE}/users.list`,
  usersProfile: `${SLACK_API_BASE}/users.profile.get`,

  // Conversations
  conversationsList: `${SLACK_API_BASE}/conversations.list`,
  conversationsHistory: `${SLACK_API_BASE}/conversations.history`,
  conversationsReplies: `${SLACK_API_BASE}/conversations.replies`,
  conversationsInfo: `${SLACK_API_BASE}/conversations.info`,
  conversationsMembers: `${SLACK_API_BASE}/conversations.members`,

  // Messages
  chatPostMessage: `${SLACK_API_BASE}/chat.postMessage`,
  chatUpdate: `${SLACK_API_BASE}/chat.update`,
  chatDelete: `${SLACK_API_BASE}/chat.delete`,

  // Reactions
  reactionsAdd: `${SLACK_API_BASE}/reactions.add`,
  reactionsRemove: `${SLACK_API_BASE}/reactions.remove`,
} as const

// ============================================================================
// HTTP Headers
// ============================================================================

export const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
} as const

// ============================================================================
// Retry Configuration
// ============================================================================

export const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000,
  // Status codes that indicate auth failure (don't retry)
  authErrorStatusCodes: [401, 403] as const,
  // Status codes that are retriable
  retryableStatusCodes: [429, 500, 502, 503, 504] as const,
  // Slack API error codes that indicate token expiration
  tokenExpiredErrors: ['token_expired', 'invalid_auth', 'not_authed', 'account_inactive'] as const,
} as const

// ============================================================================
// Pagination
// ============================================================================

export const PAGINATION = {
  defaultLimit: 100,
  maxLimit: 1000,
} as const
