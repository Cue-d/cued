/**
 * Twitter SSE streaming client.
 * Ported from mautrix/twitter stream_client.go.
 *
 * Subscribes to ONE active conversation at a time for real-time DM update
 * and typing notifications. Polling (getDMUserUpdates) handles all conversations;
 * streaming provides instant delivery for the focused conversation.
 */

import { API_URLS, BASE_HEADERS, DEFAULT_BEARER_TOKEN, COOKIE_NAMES } from './constants'
import type { TwitterClient } from './client'

// ============================================================================
// Types
// ============================================================================

export type StreamEvent =
  | { type: 'dm_update'; conversationId: string; userId: string }
  | { type: 'dm_typing'; conversationId: string; userId: string }
  | { type: 'config' }

interface SSEStreamEvent {
  topic?: string
  payload?: {
    config?: {
      session_id: string
      subscription_ttl_millis?: number
      heartbeat_millis?: number
    }
    dm_typing?: { conversation_id: string; user_id: string }
    dm_update?: { conversation_id: string; user_id: string }
  }
}

// ============================================================================
// Constants
// ============================================================================

const RECONNECT_DELAY_MS = 5000

// ============================================================================
// TwitterStreamClient
// ============================================================================

export class TwitterStreamClient {
  private client: TwitterClient
  private conversationId = ''
  private oldConversationId = ''
  private sessionId = ''
  private heartbeatInterval = 25_000
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private abortController: AbortController | null = null
  private onEvent: (event: StreamEvent) => void
  private running = false

  constructor(client: TwitterClient, onEvent: (event: StreamEvent) => void) {
    this.client = client
    this.onEvent = onEvent
  }

  /**
   * Set the active conversation for SSE streaming (mautrix pattern).
   * If not yet running, opens SSE connection. If running, swaps topics on next heartbeat.
   */
  setActiveConversation(conversationId: string): void {
    if (conversationId === this.conversationId) return

    if (!this.running) {
      this.conversationId = conversationId
      void this.connectLoop()
      return
    }

    // Swap: unsubscribe old, subscribe new on next heartbeat
    this.oldConversationId = this.conversationId
    this.conversationId = conversationId
    // Trigger immediate heartbeat to swap topics (mautrix short-circuit)
    if (this.sessionId) {
      void this.sendHeartbeat()
    }
  }

  stop(): void {
    this.running = false
    this.abortController?.abort()
    this.abortController = null
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.conversationId = ''
    this.oldConversationId = ''
    this.sessionId = ''
  }

  private buildTopicString(conversationId: string): string {
    return `/dm_update/${conversationId},/dm_typing/${conversationId}`
  }

  /** Connect with auto-reconnect loop. */
  private async connectLoop(): Promise<void> {
    this.running = true
    this.abortController = new AbortController()

    while (this.running && !this.abortController.signal.aborted) {
      try {
        await this.connect()
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') break
        console.warn('[TwitterStream] Connection error:', error)
      }

      if (!this.running) break
      console.log(`[TwitterStream] Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`)
      await sleep(RECONNECT_DELAY_MS)
    }
  }

  private async connect(): Promise<void> {
    if (!this.conversationId) return

    const topics = this.buildTopicString(this.conversationId)
    const url = `${API_URLS.pipelineEvents}?topic=${encodeURIComponent(topics)}`

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...BASE_HEADERS,
        accept: 'text/event-stream',
        'cache-control': 'no-cache',
        authorization: this.client.getSession().bearerToken ?? DEFAULT_BEARER_TOKEN,
        cookie: this.client.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
        'x-csrf-token':
          this.client.cookies.find((c) => c.name === COOKIE_NAMES.csrfToken)?.value ?? '',
        'x-twitter-auth-type': 'OAuth2Session',
      },
      signal: this.abortController!.signal,
    })

    if (!response.ok || !response.body) {
      const isClientError = response.status >= 400 && response.status < 500
      console.warn(`[TwitterStream] SSE connection failed: ${response.status}${isClientError ? ' (auth/client error — will not retry)' : ''}`)
      if (isClientError) {
        this.running = false
      }
      return
    }

    console.log(`[TwitterStream] Connected, watching conversation ${this.conversationId}`)
    await this.readSSEStream(response.body)
  }

  private async readSSEStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line || line === ':') continue

          const colonIndex = line.indexOf(':')
          if (colonIndex <= 0) continue

          const field = line.slice(0, colonIndex)
          const dataValue = line.slice(colonIndex + 1).trimStart()

          if (field !== 'data') continue

          let evt: SSEStreamEvent
          try {
            evt = JSON.parse(dataValue) as SSEStreamEvent
          } catch {
            continue // Skip malformed JSON
          }
          try {
            this.handleStreamEvent(evt)
          } catch (handlerError) {
            console.warn('[TwitterStream] Event handler error:', handlerError instanceof Error ? handlerError.message : handlerError)
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return
      console.warn('[TwitterStream] SSE read error:', error)
    } finally {
      reader.releaseLock()
    }
  }

  private handleStreamEvent(evt: SSEStreamEvent): void {
    const config = evt.payload?.config
    if (config) {
      if (config.heartbeat_millis && config.heartbeat_millis > 0) {
        this.heartbeatInterval = config.heartbeat_millis
      }
      if (config.session_id) {
        const firstSession = !this.sessionId
        this.sessionId = config.session_id
        if (firstSession) {
          this.startHeartbeatLoop()
        }
      }
      this.onEvent({ type: 'config' })
      return
    }

    const dmUpdate = evt.payload?.dm_update
    if (dmUpdate) {
      this.onEvent({
        type: 'dm_update',
        conversationId: dmUpdate.conversation_id,
        userId: dmUpdate.user_id,
      })
      return
    }

    const dmTyping = evt.payload?.dm_typing
    if (dmTyping) {
      this.onEvent({
        type: 'dm_typing',
        conversationId: dmTyping.conversation_id,
        userId: dmTyping.user_id,
      })
    }
  }

  private startHeartbeatLoop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)

    void this.sendHeartbeat()
    this.heartbeatTimer = setInterval(
      () => void this.sendHeartbeat(),
      this.heartbeatInterval
    )
  }

  /** Send heartbeat: subscribe to current conversation, unsubscribe from old. */
  private async sendHeartbeat(): Promise<void> {
    if (!this.sessionId || !this.conversationId) return

    const subTopics = this.buildTopicString(this.conversationId)
    const unsubTopics = this.oldConversationId ? this.buildTopicString(this.oldConversationId) : ''

    if (this.oldConversationId) {
      this.oldConversationId = ''
    }

    const form = new URLSearchParams()
    form.set('sub_topics', subTopics)
    if (unsubTopics) form.set('unsub_topics', unsubTopics)

    try {
      const response = await fetch(API_URLS.pipelineUpdateSubscriptions, {
        method: 'POST',
        headers: {
          ...BASE_HEADERS,
          'content-type': 'application/x-www-form-urlencoded',
          authorization: this.client.getSession().bearerToken ?? DEFAULT_BEARER_TOKEN,
          cookie: this.client.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
          'x-csrf-token':
            this.client.cookies.find((c) => c.name === COOKIE_NAMES.csrfToken)?.value ?? '',
          'x-twitter-auth-type': 'OAuth2Session',
          'livepipeline-session': this.sessionId,
        },
        body: form.toString(),
        signal: this.abortController?.signal,
      })
      if (!response.ok) {
        console.warn(`[TwitterStream] Subscription update failed: ${response.status}`)
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return
      console.warn('[TwitterStream] Subscription update error:', error)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
