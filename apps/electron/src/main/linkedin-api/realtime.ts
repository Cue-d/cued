/**
 * LinkedIn Realtime SSE Connection
 * Ported from mautrix-linkedin Go client
 * Reference: https://github.com/mautrix/linkedin/blob/main/pkg/linkedingo/realtime.go
 */

import {
  API_URLS,
  CONTENT_TYPES,
  DEFAULT_X_LI_TRACK,
  GRAPHQL_QUERY_IDS,
} from './constants'
import { formatCookieHeader, getCSRFToken } from './request'
import type { Cookie, EventHandlers, Message, Conversation, MessagingParticipant } from './types'

// ============================================================================
// Constants
// ============================================================================

const HEARTBEAT_INTERVAL_MS = 60_000 // 60 seconds
const MAX_RECONNECT_ATTEMPTS = 50
const MAX_BACKOFF_SECONDS = 60
const SERVICE_VERSION = '1.13.40953'

/**
 * X-LI-Query-Map header value - tells LinkedIn which topics to subscribe to
 * and their corresponding GraphQL query IDs for decoration.
 * From: https://github.com/mautrix/linkedin/blob/main/pkg/linkedingo/x-li-query-map.json
 */
const REALTIME_QUERY_MAP = JSON.stringify({
  topicToGraphQLQueryParams: {
    conversationsBroadcastTopic: {
      queryId: 'voyagerMessagingDashMessengerRealtimeDecoration.f855048b390b286e513d7b23c59efee3',
      variables: {},
      extensions: {},
    },
    conversationsTopic: {
      queryId: 'voyagerMessagingDashMessengerRealtimeDecoration.f855048b390b286e513d7b23c59efee3',
      variables: {},
      extensions: {},
    },
    conversationDeletesBroadcastTopic: {
      queryId: 'voyagerMessagingDashMessengerRealtimeDecoration.282abe5fa1a242cb76825c32dbbfaede',
      variables: {},
      extensions: {},
    },
    conversationDeletesTopic: {
      queryId: 'voyagerMessagingDashMessengerRealtimeDecoration.282abe5fa1a242cb76825c32dbbfaede',
      variables: {},
      extensions: {},
    },
    messageReactionSummariesBroadcastTopic: {
      queryId: 'voyagerMessagingDashMessengerRealtimeDecoration.85ff5a1aabf7c52f40aa85ccc84e3bf5',
      variables: {},
      extensions: {},
    },
    messageReactionSummariesTopic: {
      queryId: 'voyagerMessagingDashMessengerRealtimeDecoration.85ff5a1aabf7c52f40aa85ccc84e3bf5',
      variables: {},
      extensions: {},
    },
    messageSeenReceiptsBroadcastTopic: {
      queryId: 'voyagerMessagingDashMessengerRealtimeDecoration.e23d3971dc83a115b03584cf2381256c',
      variables: {},
      extensions: {},
    },
    messageSeenReceiptsTopic: {
      queryId: 'voyagerMessagingDashMessengerRealtimeDecoration.e23d3971dc83a115b03584cf2381256c',
      variables: {},
      extensions: {},
    },
    messagesBroadcastTopic: {
      queryId: 'voyagerMessagingDashMessengerRealtimeDecoration.db0f1d3f53747f49f3fd87b139df9eda',
      variables: {},
      extensions: {},
    },
    messagesTopic: {
      queryId: 'voyagerMessagingDashMessengerRealtimeDecoration.db0f1d3f53747f49f3fd87b139df9eda',
      variables: {},
      extensions: {},
    },
    replySuggestionBroadcastTopic: {
      queryId: 'voyagerMessagingDashMessengerRealtimeDecoration.412964c3f7f5a67fb0e56b6bb3a00028',
      variables: {},
      extensions: {},
    },
    replySuggestionTopicV2: {
      queryId: 'voyagerMessagingDashMessengerRealtimeDecoration.412964c3f7f5a67fb0e56b6bb3a00028',
      variables: {},
      extensions: {},
    },
    typingIndicatorsBroadcastTopic: {
      queryId: 'voyagerMessagingDashMessengerRealtimeDecoration.234ce03cd062b2438dae060ca854a6d2',
      variables: {},
      extensions: {},
    },
    typingIndicatorsTopic: {
      queryId: 'voyagerMessagingDashMessengerRealtimeDecoration.234ce03cd062b2438dae060ca854a6d2',
      variables: {},
      extensions: {},
    },
  },
})

/**
 * X-LI-Recipe-Map header value - decoration recipes for specific topics.
 * From: https://github.com/mautrix/linkedin/blob/main/pkg/linkedingo/x-li-recipe-map.json
 */
const REALTIME_RECIPE_MAP = JSON.stringify({
  inAppAlertsTopic: 'com.linkedin.voyager.dash.deco.identity.notifications.InAppAlert-52',
  professionalEventsTopic: 'com.linkedin.voyager.dash.deco.events.ProfessionalEventDetailPage-63',
  tabBadgeUpdateTopic: 'com.linkedin.voyager.dash.deco.notifications.RealtimeBadgingItemCountsEvent-1',
  topCardLiveVideoTopic: 'com.linkedin.voyager.dash.deco.video.TopCardLiveVideo-10',
})

// ============================================================================
// Event Types
// ============================================================================

interface RealtimeEvent {
  'com.linkedin.realtimefrontend.Heartbeat'?: HeartbeatEvent
  'com.linkedin.realtimefrontend.ClientConnection'?: ClientConnectionEvent
  'com.linkedin.realtimefrontend.DecoratedEvent'?: DecoratedEvent
}

interface HeartbeatEvent {
  // Empty - just a keep-alive signal
}

interface ClientConnectionEvent {
  id?: string
}

interface DecoratedEvent {
  topic?: string
  payload?: {
    data?: unknown
  }
}

interface HeartbeatPayload {
  isFirstHeartbeat: boolean
  isLastHeartbeat: boolean
  realtimeSessionId: string
  mpName: string
  mpVersion: string
  clientId: string
  actorUrn: string
  contextUrns: string[]
}

// ============================================================================
// RealtimeConnection Class
// ============================================================================

export class RealtimeConnection {
  private cookies: Cookie[]
  private userEntityURN: string
  private handlers: EventHandlers

  private sessionId: string
  private abortController: AbortController | null = null
  private heartbeatInterval: NodeJS.Timeout | null = null
  private isFirstHeartbeat = true
  private connectAttempts = 0
  private isConnected = false
  private shouldReconnect = true

  constructor(
    cookies: Cookie[],
    userEntityURN: string,
    handlers: EventHandlers = {}
  ) {
    this.cookies = cookies
    this.userEntityURN = userEntityURN
    this.handlers = handlers
    this.sessionId = this.generateSessionId()
  }

  // ============================================================================
  // Public Methods
  // ============================================================================

  /**
   * Start the realtime connection.
   * Connects to SSE endpoint and begins heartbeat loop.
   */
  async start(): Promise<void> {
    if (this.isConnected) {
      console.log('[LinkedInRealtime] Already connected')
      return
    }

    this.shouldReconnect = true
    await this.connect()
  }

  /**
   * Stop the realtime connection.
   * Closes SSE connection and stops heartbeat.
   */
  stop(): void {
    console.log('[LinkedInRealtime] Stopping connection')
    this.shouldReconnect = false
    this.disconnect()
  }

  /**
   * Update event handlers.
   */
  setHandlers(handlers: EventHandlers): void {
    this.handlers = handlers
  }

  /**
   * Check if connected.
   */
  get connected(): boolean {
    return this.isConnected
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  private async connect(): Promise<void> {
    while (this.shouldReconnect && this.connectAttempts < MAX_RECONNECT_ATTEMPTS) {
      try {
        console.log(`[LinkedInRealtime] Connecting (attempt ${this.connectAttempts + 1})...`)
        await this.doConnect()

        // If we get here, connection closed normally
        if (this.shouldReconnect) {
          console.log('[LinkedInRealtime] Connection closed, reconnecting...')
          this.scheduleReconnect()
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.log(`[LinkedInRealtime] Connection error: ${message}`)

        if (!this.shouldReconnect) {
          break
        }

        // Handle specific HTTP errors
        if (message.includes('400')) {
          console.log('[LinkedInRealtime] Got 400, generating new session ID')
          this.sessionId = this.generateSessionId()
        }

        this.scheduleReconnect()
      }
    }

    if (this.connectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.log('[LinkedInRealtime] Max reconnect attempts reached')
      this.handlers.onDisconnected?.(new Error('Max reconnect attempts reached'))
    }
  }

  private async doConnect(): Promise<void> {
    this.abortController = new AbortController()

    const url = `${API_URLS.realtimeConnect}?rc=1`
    const csrfToken = getCSRFToken(this.cookies)

    const headers: Record<string, string> = {
      // SSE content type
      Accept: CONTENT_TYPES.eventStream,
      Cookie: formatCookieHeader(this.cookies),
      // LinkedIn tracking
      'x-li-track': DEFAULT_X_LI_TRACK,
      // Realtime subscription headers - critical for receiving events
      'X-LI-Accept': CONTENT_TYPES.linkedInNormalized,
      'X-LI-Query-Accept': CONTENT_TYPES.graphql,
      'X-LI-Query-Map': REALTIME_QUERY_MAP,
      'X-LI-Recipe-Accept': CONTENT_TYPES.linkedInNormalized,
      'X-LI-Recipe-Map': REALTIME_RECIPE_MAP,
      'X-LI-Realtime-Session': this.sessionId,
      // Security headers
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      // Additional LinkedIn headers
      Referer: `${API_URLS.messagingBase}/`,
      'x-li-page-instance': 'urn:li:page:messaging_thread;',
      'x-restli-protocol-version': '2.0.0',
    }

    if (csrfToken) {
      headers['csrf-token'] = csrfToken
    }

    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: this.abortController.signal,
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    if (!response.body) {
      throw new Error('No response body')
    }

    // Connection successful
    this.isConnected = true
    this.connectAttempts = 0
    this.isFirstHeartbeat = true
    this.handlers.onConnected?.()

    // Start heartbeat
    this.startHeartbeat()

    // Read SSE stream
    await this.readStream(response.body)
  }

  private disconnect(): void {
    this.isConnected = false

    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
  }

  private scheduleReconnect(): void {
    this.disconnect()
    this.connectAttempts++

    const backoffSeconds = Math.min(this.connectAttempts * 2, MAX_BACKOFF_SECONDS)
    console.log(`[LinkedInRealtime] Reconnecting in ${backoffSeconds}s...`)

    setTimeout(() => {
      if (this.shouldReconnect) {
        this.connect()
      }
    }, backoffSeconds * 1000)
  }

  // ============================================================================
  // Stream Reading
  // ============================================================================

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          console.log('[LinkedInRealtime] Stream ended')
          break
        }

        buffer += decoder.decode(value, { stream: true })

        // Process complete lines
        const lines = buffer.split('\n')
        buffer = lines.pop() || '' // Keep incomplete line in buffer

        for (const line of lines) {
          this.processLine(line)
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('[LinkedInRealtime] Stream aborted')
      } else {
        throw error
      }
    } finally {
      reader.releaseLock()
    }
  }

  private processLine(line: string): void {
    // SSE format: "data: {...json...}"
    if (!line.startsWith('data:')) {
      return
    }

    const jsonStr = line.slice(5).trim() // Remove "data:" prefix
    if (!jsonStr) {
      return
    }

    try {
      const event = JSON.parse(jsonStr) as RealtimeEvent
      // Debug: log event types we receive
      const eventTypes = Object.keys(event).filter(k => event[k as keyof RealtimeEvent])
      console.log(`[LinkedInRealtime] Event received: ${eventTypes.join(', ')}`)
      this.handleEvent(event)
    } catch (error) {
      console.log(`[LinkedInRealtime] Failed to parse event: ${jsonStr.slice(0, 200)}...`)
    }
  }

  // ============================================================================
  // Event Handling
  // ============================================================================

  private handleEvent(event: RealtimeEvent): void {
    if (event['com.linkedin.realtimefrontend.Heartbeat']) {
      this.handleHeartbeat()
    } else if (event['com.linkedin.realtimefrontend.ClientConnection']) {
      this.handleClientConnection(event['com.linkedin.realtimefrontend.ClientConnection'])
    } else if (event['com.linkedin.realtimefrontend.DecoratedEvent']) {
      this.handleDecoratedEvent(event['com.linkedin.realtimefrontend.DecoratedEvent'])
    }
  }

  private handleHeartbeat(): void {
    this.handlers.onHeartbeat?.()
  }

  private handleClientConnection(event: ClientConnectionEvent): void {
    if (event.id) {
      console.log(`[LinkedInRealtime] Client connection ID: ${event.id}`)
    }
  }

  private handleDecoratedEvent(event: DecoratedEvent): void {
    const topic = event.topic
    const payload = event.payload?.data

    console.log(`[LinkedInRealtime] Decorated event - topic: ${topic}`)

    if (!topic || !payload) {
      console.log(`[LinkedInRealtime] Missing topic or payload`)
      return
    }

    // Debug: log payload structure
    console.log(`[LinkedInRealtime] Payload keys: ${Object.keys(payload as object).join(', ')}`)

    // Route to appropriate handler based on topic
    if (topic.includes('messages') || topic.includes('Messages')) {
      console.log(`[LinkedInRealtime] Routing to message handler`)
      this.handleMessageEvent(payload)
    } else if (topic.includes('typing') || topic.includes('Typing')) {
      this.handleTypingEvent(payload)
    } else if (topic.includes('conversation') || topic.includes('Conversation')) {
      console.log(`[LinkedInRealtime] Routing to conversation handler`)
      this.handleConversationEvent(payload)
    } else if (topic.includes('reaction') || topic.includes('Reaction')) {
      this.handleReactionEvent(payload)
    } else if (topic.includes('seen') || topic.includes('Seen')) {
      this.handleSeenReceiptEvent(payload)
    } else {
      console.log(`[LinkedInRealtime] Unhandled topic: ${topic}`)
    }
  }

  private handleMessageEvent(payload: unknown): void {
    // Parse the decorated message payload
    const message = this.parseMessagePayload(payload)
    if (message) {
      this.handlers.onMessage?.(message)
    }
  }

  private handleTypingEvent(payload: unknown): void {
    const data = payload as {
      conversationUrn?: string
      fromEntity?: { entityUrn?: string }
    }

    if (data.conversationUrn && data.fromEntity?.entityUrn) {
      const participant: MessagingParticipant = {
        entityURN: data.fromEntity.entityUrn,
        participantType: {},
      }
      this.handlers.onTypingIndicator?.(data.conversationUrn, participant)
    }
  }

  private handleConversationEvent(payload: unknown): void {
    const conversation = this.parseConversationPayload(payload)
    if (conversation) {
      this.handlers.onConversationUpdate?.(conversation)
    }
  }

  private handleReactionEvent(payload: unknown): void {
    // Reactions update - could trigger a message refresh
    // For now, treat as a conversation update signal
    console.log('[LinkedInRealtime] Reaction event received')
  }

  private handleSeenReceiptEvent(payload: unknown): void {
    // Seen receipts - could update read status
    console.log('[LinkedInRealtime] Seen receipt event received')
  }

  // ============================================================================
  // Payload Parsing
  // ============================================================================

  private parseMessagePayload(payload: unknown): Message | null {
    try {
      // LinkedIn's decorated event payload structure varies
      // Try to extract message data from common locations
      const data = payload as Record<string, unknown>

      // Look for message in various possible locations
      const rawMessage = data.message || data.value || data

      if (!rawMessage || typeof rawMessage !== 'object') {
        return null
      }

      const msg = rawMessage as Record<string, unknown>

      return {
        entityURN: String(msg.entityUrn || msg.backendUrn || ''),
        body: {
          text: typeof msg.body === 'object' && msg.body
            ? String((msg.body as Record<string, unknown>).text || '')
            : '',
        },
        deliveredAt: Number(msg.deliveredAt) || Date.now(),
        sender: this.parseSender(msg.sender),
        messageBodyRenderFormat: (msg.messageBodyRenderFormat as Message['messageBodyRenderFormat']) || 'DEFAULT',
        conversationURN: String(msg.conversationUrn || msg['*conversation'] || ''),
      }
    } catch {
      return null
    }
  }

  private parseConversationPayload(payload: unknown): Conversation | null {
    try {
      const data = payload as Record<string, unknown>
      const rawConv = data.conversation || data.value || data

      if (!rawConv || typeof rawConv !== 'object') {
        return null
      }

      const conv = rawConv as Record<string, unknown>

      return {
        entityURN: String(conv.entityUrn || ''),
        title: String(conv.title || ''),
        lastActivityAt: Number(conv.lastActivityAt) || Date.now(),
        lastReadAt: Number(conv.lastReadAt) || 0,
        groupChat: Boolean(conv.groupChat),
        conversationParticipants: [],
        read: Boolean(conv.read),
        categories: Array.isArray(conv.categories) ? conv.categories : [],
        unreadCount: Number(conv.unreadCount) || 0,
      }
    } catch {
      return null
    }
  }

  private parseSender(sender: unknown): MessagingParticipant {
    if (!sender || typeof sender !== 'object') {
      return { entityURN: '', participantType: {} }
    }

    const s = sender as Record<string, unknown>
    return {
      entityURN: String(s.entityUrn || ''),
      participantType: {},
    }
  }

  // ============================================================================
  // Heartbeat
  // ============================================================================

  private startHeartbeat(): void {
    // Send first heartbeat immediately
    this.sendHeartbeat()

    // Then send every 60 seconds
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat()
    }, HEARTBEAT_INTERVAL_MS)
  }

  private async sendHeartbeat(): Promise<void> {
    try {
      const payload: HeartbeatPayload = {
        isFirstHeartbeat: this.isFirstHeartbeat,
        isLastHeartbeat: false,
        realtimeSessionId: this.sessionId,
        mpName: 'voyager-web',
        mpVersion: SERVICE_VERSION,
        clientId: 'voyager-web',
        actorUrn: this.userEntityURN,
        contextUrns: [this.userEntityURN],
      }

      const url = `${API_URLS.realtimeHeartbeat}?action=sendHeartbeat`
      const csrfToken = getCSRFToken(this.cookies)

      const headers: Record<string, string> = {
        'Content-Type': CONTENT_TYPES.jsonUtf8,
        Cookie: formatCookieHeader(this.cookies),
        'x-li-track': DEFAULT_X_LI_TRACK,
      }

      if (csrfToken) {
        headers['csrf-token'] = csrfToken
      }

      await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      })

      this.isFirstHeartbeat = false
    } catch (error) {
      console.log(`[LinkedInRealtime] Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  private generateSessionId(): string {
    // Generate UUID v4-like string
    const hex = () => Math.random().toString(16).substring(2, 10)
    return `${hex()}-${hex().substring(0, 4)}-4${hex().substring(1, 4)}-${hex().substring(0, 4)}-${hex()}${hex().substring(0, 4)}`
  }
}
