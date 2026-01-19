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

  // ============================================================================
  // Event Handlers
  // ============================================================================

  /**
   * Set event handlers for real-time updates.
   */
  setEventHandlers(handlers: EventHandlers): void {
    this._eventHandlers = handlers
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
    // Implementation in messages.ts
    void conversationId
    void cursor
    throw new Error('Not implemented - see messages.ts')
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
    // Implementation in messages.ts
    void conversationId
    void timestamp
    throw new Error('Not implemented - see messages.ts')
  }

  /**
   * Send a message to a conversation.
   * @param conversationId - The conversation URN or ID
   * @param text - The message text to send
   * @returns Promise resolving to the sent message
   */
  async sendMessage(conversationId: string, text: string): Promise<Message> {
    // Implementation in messages.ts
    void conversationId
    void text
    throw new Error('Not implemented - see messages.ts')
  }

  /**
   * Fetch connections (contacts) for the authenticated user.
   * @param cursor - Optional cursor for pagination
   * @returns Promise resolving to connections with pagination metadata
   */
  async getConnections(cursor?: string): Promise<ConnectionsResult> {
    // Implementation in contacts.ts
    void cursor
    throw new Error('Not implemented - see contacts.ts')
  }

  /**
   * Search for people on LinkedIn.
   * @param query - Search query string
   * @returns Promise resolving to matching connections
   */
  async searchPeople(query: string): Promise<ConnectionsResult> {
    // Implementation in contacts.ts
    void query
    throw new Error('Not implemented - see contacts.ts')
  }
}
