/**
 * LinkedIn API Constants
 * Ported from mautrix-linkedin Go client
 * Reference: https://github.com/mautrix/linkedin/tree/main/pkg/linkedingo
 */

// ============================================================================
// Browser Identification
// ============================================================================

export const BROWSER_NAME = 'Chrome'
export const CHROME_VERSION = '141'
export const OS_NAME = 'macOS'
export const SERVICE_VERSION = '1.13.40953'

export const USER_AGENT = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`

// ============================================================================
// Base URLs
// ============================================================================

export const BASE_URL = 'https://www.linkedin.com'

export const API_URLS = {
  voyagerGraphQL: 'https://www.linkedin.com/voyager/api/graphql',
  messagingGraphQL: 'https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql',
  logout: 'https://www.linkedin.com/uas/logout',
  messagingBase: 'https://www.linkedin.com/messaging',
  realtimeConnect: 'https://www.linkedin.com/realtime/connect',
  realtimeHeartbeat: 'https://www.linkedin.com/realtime/realtimeFrontendClientConnectivityTracking',
  commonMe: 'https://www.linkedin.com/voyager/api/me',
  mediaUploadMetadata: 'https://www.linkedin.com/voyager/api/voyagerVideoDashMediaUploadMetadata',
  messagingMessages: 'https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages',
  pushRegistration: 'https://www.linkedin.com/voyager/api/voyagerNotificationsDashPushRegistration',
  messengerConversations: 'https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerConversations',
  connections: 'https://www.linkedin.com/voyager/api/voyagerRelationshipsDashConnections',
  search: 'https://www.linkedin.com/voyager/api/voyagerSearchDash',
} as const

// ============================================================================
// Cookie Names
// ============================================================================

export const COOKIE_NAMES = {
  sessionId: 'JSESSIONID',
  authToken: 'li_at',
} as const

// ============================================================================
// Content Types
// ============================================================================

export const CONTENT_TYPES = {
  json: 'application/json',
  jsonUtf8: 'application/json; charset=UTF-8',
  linkedInNormalized: 'application/vnd.linkedin.normalized+json+2.1',
  graphql: 'application/graphql',
  eventStream: 'text/event-stream',
  plainText: 'text/plain;charset=UTF-8',
} as const

// ============================================================================
// Default Headers
// ============================================================================

export const DEFAULT_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'application/vnd.linkedin.normalized+json+2.1',
  'Accept-Language': 'en-US,en;q=0.9',
  'x-restli-protocol-version': '2.0.0',
  'x-li-lang': 'en_US',
  'x-li-page-instance': 'urn:li:page:messaging_thread;',
} as const

// ============================================================================
// GraphQL Query IDs
// ============================================================================

export const GRAPHQL_QUERY_IDS = {
  // Messaging queries
  messengerConversations: 'messengerConversations.0a1e58aeb7c5f6b3c5fe3ec336b3f09a',
  messengerConversationsBySyncToken: 'messengerConversationsBySyncToken.f2f54caf04e0a5a8723d0db0d8b71833',
  messengerMessagesByConversation: 'messengerMessagesByConversation.4fffca8ffb3c0c385f9e8dc30f6f89dd',
  messengerMessagesByAnchorTimestamp: 'messengerMessagesByAnchorTimestamp.0e5b81dc5a0c8d6e84f9dd2bc8bc5736',

  // Realtime decoration queries
  realtimeConversations: 'voyagerMessagingDashMessengerRealtimeDecoration.f855048b390b286e513d7b23c59efee3',
  realtimeConversationDeletes: 'voyagerMessagingDashMessengerRealtimeDecoration.282abe5fa1a242cb76825c32dbbfaede',
  realtimeMessageReactions: 'voyagerMessagingDashMessengerRealtimeDecoration.85ff5a1aabf7c52f40aa85ccc84e3bf5',
  realtimeMessageSeenReceipts: 'voyagerMessagingDashMessengerRealtimeDecoration.e23d3971dc83a115b03584cf2381256c',
  realtimeMessages: 'voyagerMessagingDashMessengerRealtimeDecoration.db0f1d3f53747f49f3fd87b139df9eda',
  realtimeReplySuggestions: 'voyagerMessagingDashMessengerRealtimeDecoration.412964c3f7f5a67fb0e56b6bb3a00028',
  realtimeTypingIndicators: 'voyagerMessagingDashMessengerRealtimeDecoration.234ce03cd062b2438dae060ca854a6d2',

  // Search queries
  searchClusters: 'voyagerSearchDashRealtimeDecoration.7a2ea8ee07de9b18830e4548c43eaf1e',
} as const

// ============================================================================
// Realtime Event Topics
// ============================================================================

export const REALTIME_TOPICS = {
  conversations: 'conversationsTopic',
  conversationsBroadcast: 'conversationsBroadcastTopic',
  conversationDeletes: 'conversationDeletesTopic',
  conversationDeletesBroadcast: 'conversationDeletesBroadcastTopic',
  messages: 'messagesTopic',
  messagesBroadcast: 'messagesBroadcastTopic',
  messageSeenReceipts: 'messageSeenReceiptsTopic',
  messageSeenReceiptsBroadcast: 'messageSeenReceiptsBroadcastTopic',
  typingIndicators: 'typingIndicatorsTopic',
  typingIndicatorsBroadcast: 'typingIndicatorsBroadcastTopic',
  messageReactionSummaries: 'messageReactionSummariesTopic',
  messageReactionSummariesBroadcast: 'messageReactionSummariesBroadcastTopic',
  replySuggestions: 'replySuggestionTopicV2',
  replySuggestionsBroadcast: 'replySuggestionBroadcastTopic',
  tabBadges: 'tabBadgesTopic',
  invitations: 'invitationsTopic',
  inAppAlerts: 'inAppAlertsTopic',
  presence: 'presenceStatusTopic',
} as const

// ============================================================================
// X-LI-Track Header Data
// ============================================================================

export const DEFAULT_X_LI_TRACK = JSON.stringify({
  clientVersion: SERVICE_VERSION,
  mpVersion: SERVICE_VERSION,
  osName: OS_NAME,
  timezoneOffset: -8,
  timezone: 'America/Los_Angeles',
  deviceFormFactor: 'DESKTOP',
  mpName: 'voyager-web',
  displayDensity: 2,
  displayWidth: 1920,
  displayHeight: 1080,
})

// ============================================================================
// Retry Configuration
// ============================================================================

export const RETRY_CONFIG = {
  maxRetries: 5,
  baseDelayMs: 1000, // Exponential backoff: 1s, 2s, 4s, 8s, 16s
  retryableStatusCodes: [502, 503, 504],
  authErrorStatusCodes: [401, 403],
} as const

// ============================================================================
// Pagination Defaults
// ============================================================================

export const PAGINATION_DEFAULTS = {
  conversationsCount: 20,
  messagesCount: 20,
  connectionsCount: 40,
} as const
