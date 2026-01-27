/**
 * Slack API Client
 *
 * Uses browser session token (xoxc-) and d cookie for authentication.
 * Extracted from the user's browser session via Electron login flow.
 *
 * ## Why Polling Instead of RTM (Real-Time Messaging)
 *
 * Slack's RTM API only supports:
 * - xoxb- tokens (bot tokens from Slack apps)
 * - xoxp- tokens (legacy user tokens, deprecated)
 *
 * We use xoxc- tokens (browser session tokens) because:
 * 1. No Slack app installation required - works with any workspace
 * 2. Full access to user's DMs and private channels
 * 3. Appears as the user (not a bot)
 *
 * The tradeoff is we must use polling instead of WebSocket RTM.
 * We poll every 30 seconds which provides near-real-time updates
 * while respecting Slack's rate limits.
 */

import { SLACK_API_URLS, PAGINATION } from './constants'
import { newPostRequest, SlackAuthError } from './request'
import type {
  SlackCredentials,
  SlackAuthTestResponse,
  SlackUsersInfoResponse,
  SlackUser,
  SlackConversation,
  SlackConversationsListResponse,
  SlackConversationsHistoryResponse,
  SlackConversationsRepliesResponse,
  SlackConversationsMembersResponse,
  SlackMessage,
  SlackPostMessageResponse,
} from './types'

// ============================================================================
// Result Types
// ============================================================================

export interface ConversationsResult {
  conversations: SlackConversation[]
  nextCursor?: string
}

export interface MessagesResult {
  messages: SlackMessage[]
  hasMore: boolean
  nextCursor?: string
}

// ============================================================================
// Client Class
// ============================================================================

export class SlackClient {
  private credentials: SlackCredentials
  private teamId: string | null = null
  private userId: string | null = null
  private teamName: string | null = null

  constructor(credentials: SlackCredentials) {
    this.credentials = credentials
  }

  // ============================================================================
  // Properties
  // ============================================================================

  get isAuthenticated(): boolean {
    return !!this.credentials.token && !!this.credentials.cookie
  }

  get currentUserId(): string | null {
    return this.userId
  }

  get currentTeamId(): string | null {
    return this.teamId
  }

  get currentTeamName(): string | null {
    return this.teamName
  }

  // ============================================================================
  // Authentication
  // ============================================================================

  /**
   * Test authentication and fetch user/team info
   */
  async testAuth(): Promise<SlackAuthTestResponse> {
    const response = await newPostRequest(SLACK_API_URLS.authTest, this.credentials).doJSON<SlackAuthTestResponse>()

    if (response.ok) {
      this.teamId = response.team_id ?? null
      this.userId = response.user_id ?? null
      this.teamName = response.team ?? null
    }

    return response
  }

  // ============================================================================
  // Users
  // ============================================================================

  /**
   * Get user information by ID
   */
  async getUserInfo(userId: string): Promise<SlackUser | null> {
    const response = await newPostRequest(SLACK_API_URLS.usersInfo, this.credentials)
      .withParam('user', userId)
      .doJSON<SlackUsersInfoResponse>()

    return response.user ?? null
  }

  // ============================================================================
  // Conversations
  // ============================================================================

  /**
   * List conversations (channels, DMs, group DMs)
   * @param types - Comma-separated list: "public_channel,private_channel,mpim,im"
   * @param cursor - Pagination cursor
   * @param limit - Max results (default 100)
   */
  async listConversations(options: {
    types?: string
    cursor?: string
    limit?: number
    excludeArchived?: boolean
  } = {}): Promise<ConversationsResult> {
    const {
      types = 'public_channel,private_channel,mpim,im',
      cursor,
      limit = PAGINATION.defaultLimit,
      excludeArchived = true,
    } = options

    const response = await newPostRequest(SLACK_API_URLS.conversationsList, this.credentials)
      .withParams({
        types,
        limit,
        exclude_archived: excludeArchived,
        cursor,
      })
      .doJSON<SlackConversationsListResponse>()

    return {
      conversations: response.channels ?? [],
      nextCursor: response.response_metadata?.next_cursor,
    }
  }

  /**
   * Get conversation history (messages)
   * @param channel - Channel/conversation ID
   * @param options - Pagination and filtering options
   */
  async getHistory(
    channel: string,
    options: {
      cursor?: string
      limit?: number
      oldest?: string // Unix timestamp (exclusive)
      latest?: string // Unix timestamp (inclusive)
      inclusive?: boolean
    } = {}
  ): Promise<MessagesResult> {
    const { cursor, limit = PAGINATION.defaultLimit, oldest, latest, inclusive } = options

    const response = await newPostRequest(SLACK_API_URLS.conversationsHistory, this.credentials)
      .withParams({
        channel,
        limit,
        cursor,
        oldest,
        latest,
        inclusive,
      })
      .doJSON<SlackConversationsHistoryResponse>()

    return {
      messages: response.messages ?? [],
      hasMore: response.has_more ?? false,
      nextCursor: response.response_metadata?.next_cursor,
    }
  }

  /**
   * Get thread replies
   * @param channel - Channel/conversation ID
   * @param threadTs - Parent message timestamp
   * @param options - Pagination options
   */
  async getReplies(
    channel: string,
    threadTs: string,
    options: {
      cursor?: string
      limit?: number
      oldest?: string
      latest?: string
      inclusive?: boolean
    } = {}
  ): Promise<MessagesResult> {
    const { cursor, limit = PAGINATION.defaultLimit, oldest, latest, inclusive } = options

    const response = await newPostRequest(SLACK_API_URLS.conversationsReplies, this.credentials)
      .withParams({
        channel,
        ts: threadTs,
        limit,
        cursor,
        oldest,
        latest,
        inclusive,
      })
      .doJSON<SlackConversationsRepliesResponse>()

    return {
      messages: response.messages ?? [],
      hasMore: response.has_more ?? false,
      nextCursor: response.response_metadata?.next_cursor,
    }
  }

  /**
   * Get conversation members
   * @param channel - Channel/conversation ID
   * @param options - Pagination options
   */
  async getConversationMembers(
    channel: string,
    options: {
      cursor?: string
      limit?: number
    } = {}
  ): Promise<{ members: string[]; nextCursor?: string }> {
    const { cursor, limit = PAGINATION.defaultLimit } = options

    const response = await newPostRequest(SLACK_API_URLS.conversationsMembers, this.credentials)
      .withParams({
        channel,
        limit,
        cursor,
      })
      .doJSON<SlackConversationsMembersResponse>()

    return {
      members: response.members ?? [],
      nextCursor: response.response_metadata?.next_cursor,
    }
  }

  // ============================================================================
  // Messages
  // ============================================================================

  /**
   * Post a message to a channel or DM
   * @param channel - Channel/conversation ID
   * @param text - Message text
   * @param options - Additional options (thread_ts for replies)
   */
  async postMessage(
    channel: string,
    text: string,
    options: {
      threadTs?: string
      replyBroadcast?: boolean
      unfurlLinks?: boolean
      unfurlMedia?: boolean
    } = {}
  ): Promise<SlackPostMessageResponse> {
    const { threadTs, replyBroadcast, unfurlLinks = true, unfurlMedia = true } = options

    return newPostRequest(SLACK_API_URLS.chatPostMessage, this.credentials)
      .withParams({
        channel,
        text,
        thread_ts: threadTs,
        reply_broadcast: replyBroadcast,
        unfurl_links: unfurlLinks,
        unfurl_media: unfurlMedia,
      })
      .doJSON<SlackPostMessageResponse>()
  }
}
