// Slack integration exports

export { SlackClient } from './client'
export type { ConversationsResult, MessagesResult } from './client'

export {
  SlackAuthError,
  SlackRequestError,
  SlackRateLimitError,
  isAuthError,
  isTokenExpiredError,
} from './request'

export { SLACK_API_URLS, SLACK_API_BASE, PAGINATION, RTM_CONFIG } from './constants'

export type {
  // Auth
  SlackCredentials,
  SlackAuthTestResponse,
  // Users
  SlackUser,
  SlackUserProfile,
  SlackUsersInfoResponse,
  // Conversations
  SlackConversation,
  SlackTopic,
  SlackConversationsListResponse,
  SlackConversationsHistoryResponse,
  SlackConversationsRepliesResponse,
  // Messages
  SlackMessage,
  SlackReaction,
  SlackAttachment,
  SlackAttachmentField,
  SlackBlock,
  SlackFile,
  SlackPostMessageRequest,
  SlackPostMessageResponse,
  // RTM
  SlackRTMConnectResponse,
  SlackRTMEventType,
  SlackRTMEvent,
  SlackRTMMessageEvent,
  SlackRTMReactionEvent,
  SlackRTMTypingEvent,
  SlackEventHandlers,
  // Errors
  SlackErrorResponse,
} from './types'
