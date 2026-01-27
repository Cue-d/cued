// Slack integration exports

export { SlackClient } from './client'
export type { ConversationsResult, MessagesResult } from './client'

export {
  SlackAuthError,
  SlackRequestError,
  SlackRateLimitError,
  isSlackAuthError,
  isTokenExpiredError,
} from './request'

export { SLACK_API_URLS, SLACK_API_BASE, PAGINATION } from './constants'

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
  // Errors
  SlackErrorResponse,
} from './types'
