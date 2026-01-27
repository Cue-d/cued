/**
 * LinkedIn API Client
 * Ported from mautrix-linkedin Go client
 * Reference: https://github.com/mautrix/linkedin/blob/main/pkg/linkedingo/client.go
 */

import type {
  Cookie,
  Conversation,
  Message,
  Connection,
  EventHandlers,
  PagingMetadata,
} from './types'
import { COOKIE_NAMES, DEFAULT_X_LI_TRACK, USER_AGENT } from './constants'
import {
  getConversations as fetchConversations,
  getConversationsBefore as fetchConversationsBefore,
} from './conversations'
import { linkedInEncode } from './request'
import { RealtimeConnection } from './realtime'

export interface ConversationsResult {
  conversations: Conversation[]
  metadata?: PagingMetadata
  syncToken?: string
}

export interface MessagesResult {
  messages: Message[]
  metadata?: PagingMetadata
}

export interface ConnectionsResult {
  connections: Connection[]
  metadata?: PagingMetadata
}

export interface LinkedInClientOptions {
  cookies?: Cookie[]
  userAgent?: string
  xLiTrack?: string
  eventHandlers?: EventHandlers
}

/**
 * LinkedInClient manages authenticated requests to LinkedIn's API.
 * Uses cookie-based authentication with browser spoofing headers.
 */
export class LinkedInClient {
  /** Session cookies for authentication */
  private _cookies: Cookie[] = []

  /** URN of the logged-in user (e.g., "urn:li:fsd_profile:ABC123") */
  private _userEntityURN: string | null = null

  /** User-Agent header for requests */
  private _userAgent: string

  /** X-LI-Track header data for request tracking */
  private _xLiTrack: string

  /** Event handlers for real-time updates */
  private _eventHandlers: EventHandlers

  /** Realtime SSE connection */
  private _realtimeConnection: RealtimeConnection | null = null

  constructor(options: LinkedInClientOptions = {}) {
    this._cookies = options.cookies ?? []
    this._userAgent = options.userAgent ?? USER_AGENT
    this._xLiTrack = options.xLiTrack ?? DEFAULT_X_LI_TRACK
    this._eventHandlers = options.eventHandlers ?? {}
  }

  // ============================================================================
  // Properties
  // ============================================================================

  /** Get current cookies */
  get cookies(): Cookie[] {
    return this._cookies
  }

  /** Get the URN of the authenticated user */
  get userEntityURN(): string | null {
    return this._userEntityURN
  }

  /** Set the URN of the authenticated user */
  set userEntityURN(urn: string | null) {
    this._userEntityURN = urn
  }

  /** Get the User-Agent string */
  get userAgent(): string {
    return this._userAgent
  }

  /** Get the X-LI-Track header data */
  get xLiTrack(): string {
    return this._xLiTrack
  }

  /** Get event handlers */
  get eventHandlers(): EventHandlers {
    return this._eventHandlers
  }

  // ============================================================================
  // Cookie Management
  // ============================================================================

  /**
   * Set cookies for authentication.
   * Typically called after extracting cookies from a browser session.
   */
  setCookies(cookies: Cookie[]): void {
    this._cookies = cookies
  }

  /**
   * Get a cookie by name.
   */
  getCookie(name: string): Cookie | undefined {
    return this._cookies.find((c) => c.name === name)
  }

  /**
   * Get the value of a cookie by name.
   */
  getCookieValue(name: string): string | undefined {
    return this.getCookie(name)?.value
  }

  // ============================================================================
  // Authentication
  // ============================================================================

  /**
   * Check if the client has valid authentication cookies.
   * Requires both li_at (auth token) and JSESSIONID (session) cookies.
   */
  isAuthenticated(): boolean {
    const hasAuthToken = this._cookies.some(
      (c) => c.name === COOKIE_NAMES.authToken && c.value
    )
    const hasSessionId = this._cookies.some(
      (c) => c.name === COOKIE_NAMES.sessionId && c.value
    )
    return hasAuthToken && hasSessionId
  }

  /**
   * Get the JSESSIONID cookie value (used for CSRF token).
   * The value may be quoted, so we strip quotes if present.
   */
  getSessionId(): string | null {
    const cookie = this.getCookie(COOKIE_NAMES.sessionId)
    if (!cookie?.value) return null
    // Remove surrounding quotes if present (LinkedIn sometimes quotes the value)
    return cookie.value.replace(/^"|"$/g, '')
  }

  /**
   * Fetch the current user's profile to get the user entity URN.
   * This is required for mailbox-based API calls.
   */
  async fetchSelf(): Promise<string> {
    if (this._userEntityURN) {
      return this._userEntityURN
    }

    const { newGetRequest } = await import('./request')
    const { API_URLS, CONTENT_TYPES } = await import('./constants')

    interface MeResponse {
      data?: { plainId?: number; '*miniProfile'?: string }
      included?: Array<{ entityUrn?: string; publicIdentifier?: string; $type?: string }>
      plainId?: number
      '*miniProfile'?: string
    }

    const response = await newGetRequest(API_URLS.commonMe, this._cookies)
      .withHeader('Accept', CONTENT_TYPES.linkedInNormalized)
      .withXLIHeaders()
      .doJSON<MeResponse>()

    const plainId = response.data?.plainId ?? response.plainId

    // Look for miniProfile in included array
    const miniProfile = response.included?.find(
      (item) => item.$type?.includes('MiniProfile') || item.entityUrn?.includes('fsd_profile')
    )

    // Extract the alphanumeric ID from miniProfile URN for messaging API
    if (miniProfile?.entityUrn) {
      const match = miniProfile.entityUrn.match(/:([^:]+)$/)
      if (match) {
        this._userEntityURN = `urn:li:fsd_profile:${match[1]}`
        return this._userEntityURN
      }
    }

    // Fallback: try any entityUrn in included array
    const anyUrn = response.included?.find((item) => item.entityUrn)?.entityUrn
    if (anyUrn) {
      const match = anyUrn.match(/:([^:]+)$/)
      if (match) {
        this._userEntityURN = `urn:li:fsd_profile:${match[1]}`
        return this._userEntityURN
      }
    }

    // Last resort: use plainId (may not work for all API calls)
    if (plainId) {
      this._userEntityURN = `urn:li:fsd_profile:${plainId}`
      return this._userEntityURN
    }

    throw new Error('Could not determine user entity URN from /me response')
  }

  /**
   * Get the mailbox URN for conversation API calls.
   * Format: URL-encoded urn:li:fsd_profile:XXXXX
   * The URN value must be URL-encoded within LinkedIn's custom variable format
   */
  async getMailboxUrn(): Promise<string> {
    const userUrn = await this.fetchSelf()
    return linkedInEncode(userUrn)
  }

  // ============================================================================
  // Event Handlers
  // ============================================================================

  /**
   * Set event handlers for real-time updates.
   */
  setEventHandlers(handlers: EventHandlers): void {
    this._eventHandlers = handlers
    // Update realtime connection handlers if active
    if (this._realtimeConnection) {
      this._realtimeConnection.setHandlers(handlers)
    }
  }

  // ============================================================================
  // Realtime Connection
  // ============================================================================

  /**
   * Start realtime SSE connection for live updates.
   * Must have valid authentication and userEntityURN set.
   */
  async startRealtime(): Promise<void> {
    if (!this.isAuthenticated()) {
      throw new Error('Cannot start realtime: not authenticated')
    }

    // Ensure we have the user URN
    const userUrn = await this.fetchSelf()

    // Stop existing connection if any
    this.stopRealtime()

    // Create and start new connection
    this._realtimeConnection = new RealtimeConnection(
      this._cookies,
      userUrn,
      this._eventHandlers
    )

    await this._realtimeConnection.start()
  }

  /**
   * Stop realtime SSE connection.
   */
  stopRealtime(): void {
    if (this._realtimeConnection) {
      this._realtimeConnection.stop()
      this._realtimeConnection = null
    }
  }

  /**
   * Check if realtime connection is active.
   */
  get isRealtimeConnected(): boolean {
    return this._realtimeConnection?.connected ?? false
  }

  // ============================================================================
  // API Methods (Signatures - implementations in separate files)
  // ============================================================================

  /**
   * Fetch conversations from the inbox.
   * @param syncToken - Optional sync token for incremental updates
   * @returns Promise resolving to conversations with pagination metadata
   */
  async getConversations(syncToken?: string): Promise<ConversationsResult> {
    return fetchConversations(this, syncToken)
  }

  /**
   * Fetch conversations before a given timestamp (for pagination).
   * @param timestamp - Unix timestamp in milliseconds
   * @returns Promise resolving to conversations with pagination metadata
   */
  async getConversationsBefore(timestamp: number): Promise<ConversationsResult> {
    return fetchConversationsBefore(this, timestamp)
  }

  /**
   * Fetch messages for a conversation.
   * @param conversationId - The conversation URN or ID
   * @param cursor - Optional cursor for pagination
   * @returns Promise resolving to messages with pagination metadata
   */
  async getMessages(
    conversationId: string,
    cursor?: string
  ): Promise<MessagesResult> {
    const { getMessages } = await import('./messages')
    return getMessages(this, conversationId, cursor)
  }

  /**
   * Fetch messages before a given timestamp (for pagination).
   * @param conversationId - The conversation URN or ID
   * @param timestamp - Unix timestamp in milliseconds
   * @returns Promise resolving to messages with pagination metadata
   */
  async getMessagesBefore(
    conversationId: string,
    timestamp: number
  ): Promise<MessagesResult> {
    const { getMessagesBefore } = await import('./messages')
    return getMessagesBefore(this, conversationId, timestamp)
  }

  /**
   * Send a message to a conversation.
   * @param conversationId - The conversation URN or ID
   * @param text - The message text to send
   * @returns Promise resolving to the sent message
   */
  async sendMessage(conversationId: string, text: string): Promise<Message> {
    const { sendMessage } = await import('./messages')
    return sendMessage(this, conversationId, text)
  }

  /**
   * Fetch connections (contacts) for the authenticated user.
   * @param cursor - Optional cursor for pagination
   * @returns Promise resolving to connections with pagination metadata
   */
  async getConnections(cursor?: string): Promise<ConnectionsResult> {
    const { getConnections } = await import('./contacts')
    return getConnections(this, cursor)
  }

  /**
   * Search for people on LinkedIn.
   * @param query - Search query string
   * @returns Promise resolving to matching connections
   */
  async searchPeople(query: string): Promise<ConnectionsResult> {
    const { searchPeople } = await import('./contacts')
    return searchPeople(this, query)
  }

  /**
   * Get the public identifier (vanity URL slug) for a member URN.
   * Resolves URN-style IDs like "ACoAABsfBygBj0mn..." to vanity URLs like "johndoe".
   * @param memberUrn - The member URN or ID to resolve
   * @returns Promise resolving to profile lookup result
   */
  async getProfileByMemberUrn(memberUrn: string): Promise<import('./profile').ProfileLookupResult> {
    const { getProfileByMemberUrn } = await import('./profile')
    return getProfileByMemberUrn(this, memberUrn)
  }
}
