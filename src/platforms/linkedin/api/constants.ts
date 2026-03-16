const CHROME_VERSION = "141";
const OS_NAME = "macOS";
const SERVICE_VERSION = "1.13.40953";

export const USER_AGENT = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`;

export const API_URLS = {
  voyagerGraphQL: "https://www.linkedin.com/voyager/api/graphql",
  messagingGraphQL: "https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql",
  commonMe: "https://www.linkedin.com/voyager/api/me",
  connections: "https://www.linkedin.com/voyager/api/relationships/dash/connections",
  search: "https://www.linkedin.com/voyager/api/voyagerSearchDash",
  messagingBase: "https://www.linkedin.com/messaging",
  realtimeConnect: "https://www.linkedin.com/realtime/connect",
  realtimeHeartbeat: "https://www.linkedin.com/realtime/realtimeFrontendClientConnectivityTracking",
} as const;

export const COOKIE_NAMES = {
  sessionId: "JSESSIONID",
  authToken: "li_at",
} as const;

export const CONTENT_TYPES = {
  jsonUtf8: "application/json; charset=UTF-8",
  linkedInNormalized: "application/vnd.linkedin.normalized+json+2.1",
  graphql: "application/graphql",
} as const;

export const DEFAULT_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: CONTENT_TYPES.linkedInNormalized,
  "Accept-Language": "en-US,en;q=0.9",
  "x-restli-protocol-version": "2.0.0",
  "x-li-lang": "en_US",
  "x-li-page-instance": "urn:li:page:messaging_thread;",
} as const;

export const GRAPHQL_QUERY_IDS = {
  messengerConversations: "messengerConversations.0d5e6781bbee71c3e51c8843c6519f48",
  messengerConversationsBySyncToken: "messengerConversations.74c17e85611b60b7ba2700481151a316",
  messengerConversationsByCursor: "messengerConversations.9501074288a12f3ae9e3c7ea243bccbf",
  messengerMessagesByConversation: "messengerMessages.5846eeb71c981f11e0134cb6626cc314",
  messengerMessagesByAnchorTimestamp: "messengerMessages.4088d03bc70c91c3fa68965cb42336de",
  messengerMessagingParticipantsByMessageAndEmoji:
    "messengerMessagingParticipants.6bedbcf9406fa19045dc627ffc51f286",
} as const;

export const DEFAULT_X_LI_TRACK = JSON.stringify({
  clientVersion: SERVICE_VERSION,
  mpVersion: SERVICE_VERSION,
  osName: OS_NAME,
  timezoneOffset: -8,
  timezone: "America/Los_Angeles",
  deviceFormFactor: "DESKTOP",
  mpName: "voyager-web",
  displayDensity: 2,
  displayWidth: 1920,
  displayHeight: 1080,
});

export const RETRY_CONFIG = {
  maxRetries: 5,
  baseDelayMs: 1000,
  retryableStatusCodes: [429, 502, 503, 504],
  authErrorStatusCodes: [401, 403],
} as const;

export const REALTIME_TOPICS = {
  conversations: "conversationsTopic",
  conversationDeletes: "conversationDeletesTopic",
  messageSeenReceipts: "messageSeenReceiptsTopic",
  messages: "messagesTopic",
  messageReactionSummaries: "messageReactionSummariesTopic",
} as const;

export const PAGINATION_DEFAULTS = {
  conversationsCount: 20,
  messagesCount: 20,
  connectionsCount: 40,
} as const;
