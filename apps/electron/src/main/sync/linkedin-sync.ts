/**
 * LinkedIn Sync Manager
 * Manages background sync of LinkedIn conversations and messages to Convex.
 * Uses realtime SSE for live updates with periodic sync as fallback.
 */

import { ConvexHttpClient } from 'convex/browser'
import { api } from '@prm/convex'
import { electronEnv } from '@prm/env/electron'
import type { LinkedInClient } from '../linkedin-api/client'
import type { Conversation, Message, EventHandlers } from '../linkedin-api/types'
import { getMessages, getMessagesBefore } from '../linkedin-api/messages'

// ============================================================================
// Constants
// ============================================================================

/** Fallback sync interval when realtime disconnects: 5 minutes */
const FALLBACK_SYNC_INTERVAL_MS = 5 * 60 * 1000

/** Periodic full sync interval (even with realtime): 30 minutes */
const FULL_SYNC_INTERVAL_MS = 30 * 60 * 1000

/** Convex URL from environment */
const CONVEX_URL = electronEnv.CONVEX_URL

/** Maximum conversations to sync per cycle */
const MAX_CONVERSATIONS_PER_SYNC = 50

/** Maximum messages to fetch per conversation */
const MAX_MESSAGES_PER_CONVERSATION = 100

// ============================================================================
// Types
// ============================================================================

export interface LinkedInSyncProgress {
  status: 'idle' | 'syncing' | 'realtime' | 'error'
  lastSyncAt?: number
  totalConversationsSynced: number
  totalMessagesSynced: number
  realtimeConnected: boolean
  currentConversation?: {
    conversationId: string
    messagesInConversation: number
  }
  error?: string
}

export interface LinkedInSyncManagerOptions {
  onProgress?: (progress: LinkedInSyncProgress) => void
  getAuthToken?: () => Promise<string | null>
  onAuthInvalid?: () => void
  /** Use realtime SSE instead of polling (default: true) */
  useRealtime?: boolean
}

// ============================================================================
// LinkedInSyncManager
// ============================================================================

/**
 * Manages background sync of LinkedIn conversations and messages.
 * Uses realtime SSE for live updates, with polling as fallback.
 */
export class LinkedInSyncManager {
  /** LinkedIn API client for making requests */
  private _client: LinkedInClient | null = null

  /** Convex HTTP client for syncing data */
  private convexClient: ConvexHttpClient

  /** Per-conversation pagination cursors */
  private conversationCursors: Map<string, string> = new Map()

  /** Sync token for incremental conversation fetches */
  private conversationSyncToken: string | null = null

  /** Fallback polling interval timer ID */
  private fallbackIntervalId: NodeJS.Timeout | null = null

  /** Full sync interval timer ID */
  private fullSyncIntervalId: NodeJS.Timeout | null = null

  /** Flag to prevent concurrent syncs */
  private isRunning = false

  /** Current sync progress */
  private progress: LinkedInSyncProgress = {
    status: 'idle',
    totalConversationsSynced: 0,
    totalMessagesSynced: 0,
    realtimeConnected: false,
  }

  /** Options passed at construction */
  private options: LinkedInSyncManagerOptions

  /** Whether realtime mode is enabled */
  private useRealtime: boolean

  constructor(options: LinkedInSyncManagerOptions = {}) {
    this.options = options
    this.convexClient = new ConvexHttpClient(CONVEX_URL)
    this.useRealtime = options.useRealtime !== false // default true
  }

  // ============================================================================
  // Properties
  // ============================================================================

  /** Get the LinkedIn client */
  get client(): LinkedInClient | null {
    return this._client
  }

  /** Set the LinkedIn client */
  setClient(client: LinkedInClient): void {
    this._client = client
  }

  // ============================================================================
  // Lifecycle Methods
  // ============================================================================

  /**
   * Start sync - uses realtime if enabled, otherwise falls back to polling.
   * Always runs an initial full sync, then switches to realtime.
   */
  async start(): Promise<void> {
    if (!this._client) {
      console.log('[LinkedInSync] ERROR: No LinkedIn client configured')
      this.updateProgress({ status: 'error', error: 'LinkedIn client not configured' })
      return
    }

    // Set up auth
    if (this.options.getAuthToken) {
      const token = await this.options.getAuthToken()
      if (token) {
        this.convexClient.setAuth(token)
      } else {
        this.options.onAuthInvalid?.()
        this.updateProgress({ status: 'error', error: 'Not authenticated' })
        return
      }
    }

    // Run initial full sync
    console.log('[LinkedInSync] Running initial sync...')
    await this.runSync()

    if (this.useRealtime) {
      // Start realtime connection
      await this.startRealtime()
    } else {
      // Fall back to polling
      this.startPolling()
    }

    // Schedule periodic full syncs (even with realtime, for consistency)
    this.fullSyncIntervalId = setInterval(() => {
      console.log('[LinkedInSync] Running periodic full sync...')
      this.runSync()
    }, FULL_SYNC_INTERVAL_MS)
  }

  /**
   * Stop all sync operations.
   */
  stop(): void {
    console.log('[LinkedInSync] Stopping sync...')

    // Stop realtime
    if (this._client) {
      this._client.stopRealtime()
    }
    this.updateProgress({ realtimeConnected: false })

    // Stop polling intervals
    if (this.fallbackIntervalId) {
      clearInterval(this.fallbackIntervalId)
      this.fallbackIntervalId = null
    }

    if (this.fullSyncIntervalId) {
      clearInterval(this.fullSyncIntervalId)
      this.fullSyncIntervalId = null
    }

    this.updateProgress({ status: 'idle' })
  }

  // ============================================================================
  // Realtime Methods
  // ============================================================================

  /**
   * Start realtime SSE connection.
   */
  private async startRealtime(): Promise<void> {
    if (!this._client) return

    console.log('[LinkedInSync] Starting realtime connection...')

    // Set up event handlers
    const handlers: EventHandlers = {
      onConnected: () => {
        console.log('[LinkedInSync] Realtime connected')
        this.updateProgress({ status: 'realtime', realtimeConnected: true })
        // Stop fallback polling since realtime is working
        this.stopPolling()
      },
      onDisconnected: (error) => {
        console.log(`[LinkedInSync] Realtime disconnected: ${error?.message ?? 'unknown'}`)
        this.updateProgress({ realtimeConnected: false })
        // Start fallback polling
        this.startPolling()
      },
      onMessage: (message) => {
        console.log(`[LinkedInSync] Realtime message: ${message.entityURN}`)
        this.handleRealtimeMessage(message)
      },
      onConversationUpdate: (conversation) => {
        console.log(`[LinkedInSync] Realtime conversation update: ${conversation.entityURN}`)
        this.handleRealtimeConversation(conversation)
      },
      onTypingIndicator: (conversationURN, participant) => {
        // Could emit typing events to UI if needed
        console.log(`[LinkedInSync] Typing: ${participant.entityURN} in ${conversationURN}`)
      },
      onHeartbeat: () => {
        // Connection is alive
      },
    }

    this._client.setEventHandlers(handlers)

    try {
      await this._client.startRealtime()
    } catch (error) {
      console.log(`[LinkedInSync] Failed to start realtime: ${error instanceof Error ? error.message : String(error)}`)
      // Fall back to polling
      this.startPolling()
    }
  }

  /**
   * Handle a message received via realtime.
   */
  private async handleRealtimeMessage(message: Message): Promise<void> {
    try {
      await this.syncMessagesToConvex(message.conversationURN, [message])
      this.updateProgress({
        totalMessagesSynced: this.progress.totalMessagesSynced + 1,
      })
    } catch (error) {
      console.log(`[LinkedInSync] Error syncing realtime message: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Handle a conversation update received via realtime.
   */
  private async handleRealtimeConversation(conversation: Conversation): Promise<void> {
    try {
      await this.syncConversationToConvex(conversation)
      this.updateProgress({
        totalConversationsSynced: this.progress.totalConversationsSynced + 1,
      })
    } catch (error) {
      console.log(`[LinkedInSync] Error syncing realtime conversation: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ============================================================================
  // Polling Methods (Fallback)
  // ============================================================================

  /**
   * Start fallback polling.
   */
  private startPolling(): void {
    if (this.fallbackIntervalId) return

    console.log('[LinkedInSync] Starting fallback polling...')
    this.fallbackIntervalId = setInterval(() => this.runSync(), FALLBACK_SYNC_INTERVAL_MS)
  }

  /**
   * Stop fallback polling.
   */
  private stopPolling(): void {
    if (this.fallbackIntervalId) {
      console.log('[LinkedInSync] Stopping fallback polling (realtime active)')
      clearInterval(this.fallbackIntervalId)
      this.fallbackIntervalId = null
    }
  }

  // ============================================================================
  // Sync Methods
  // ============================================================================

  /**
   * Run a single sync cycle.
   * Fetches conversations, then messages for each conversation.
   */
  async runSync(): Promise<void> {
    if (this.isRunning) return

    if (!this._client) {
      this.updateProgress({ status: 'error', error: 'LinkedIn client not configured' })
      return
    }

    this.isRunning = true
    const previousStatus = this.progress.status
    this.updateProgress({ status: 'syncing' })

    try {
      // Re-auth if needed
      if (this.options.getAuthToken) {
        const token = await this.options.getAuthToken()
        if (token) {
          this.convexClient.setAuth(token)
        } else {
          this.options.onAuthInvalid?.()
          this.updateProgress({ status: 'error', error: 'Not authenticated' })
          return
        }
      }

      await this.syncConversations()

      this.updateProgress({
        status: this.progress.realtimeConnected ? 'realtime' : 'idle',
        lastSyncAt: Date.now(),
        currentConversation: undefined,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[LinkedInSync] Sync error: ${message}`)

      if (this.isAuthError(error)) {
        this.options.onAuthInvalid?.()
      }

      this.updateProgress({
        status: 'error',
        error: message,
        currentConversation: undefined,
      })
    } finally {
      this.isRunning = false
    }
  }

  /**
   * Sync conversations from LinkedIn.
   * Uses sync token for incremental updates.
   */
  async syncConversations(): Promise<void> {
    if (!this._client) throw new Error('Client not set')

    const result = await this._client.getConversations(
      this.conversationSyncToken ?? undefined
    )

    if (result.syncToken) {
      this.conversationSyncToken = result.syncToken
    }

    const conversationsToSync = result.conversations.slice(0, MAX_CONVERSATIONS_PER_SYNC)

    for (const conversation of conversationsToSync) {
      try {
        await this.syncConversationToConvex(conversation)
        await this.syncMessages(conversation.entityURN)

        this.updateProgress({
          totalConversationsSynced: this.progress.totalConversationsSynced + 1,
        })
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error(`[LinkedInSync] Error syncing conversation: ${msg}`)
      }
    }
  }

  /**
   * Sync messages for a specific conversation.
   * Uses per-conversation cursor for pagination.
   */
  async syncMessages(conversationId: string): Promise<void> {
    if (!this._client) throw new Error('Client not set')

    this.updateProgress({
      currentConversation: { conversationId, messagesInConversation: 0 },
    })

    const cursor = this.conversationCursors.get(conversationId)
    const result = await getMessages(this._client, conversationId, cursor)

    if (result.messages.length === 0) {
      return
    }

    await this.syncMessagesToConvex(conversationId, result.messages)

    if (result.metadata?.start !== undefined && result.metadata?.count !== undefined) {
      const nextCursor = String(result.metadata.start + result.metadata.count)
      this.conversationCursors.set(conversationId, nextCursor)
    }

    this.updateProgress({
      totalMessagesSynced: this.progress.totalMessagesSynced + result.messages.length,
      currentConversation: { conversationId, messagesInConversation: result.messages.length },
    })
  }

  // ============================================================================
  // Convex Sync Methods
  // ============================================================================

  /**
   * Sync a conversation to Convex.
   */
  private async syncConversationToConvex(conversation: Conversation): Promise<void> {
    const participants = conversation.conversationParticipants.map((p) => ({
      entityURN: p.entityURN,
      firstName: this.extractText(p.participantType.member?.firstName ?? p.participantType.organization?.name ?? ''),
      lastName: this.extractText(p.participantType.member?.lastName ?? ''),
      profileUrl: this.extractText(p.participantType.member?.profileUrl ?? p.participantType.organization?.pageUrl ?? ''),
      headline: p.participantType.member?.headline ? this.extractText(p.participantType.member.headline) : undefined,
      pictureUrl: p.participantType.member?.picture?.url ?? p.participantType.organization?.logoUrl,
    }))

    await this.convexClient.mutation(api.sync.syncLinkedInConversations, {
      conversations: [{
        entityURN: conversation.entityURN,
        title: this.extractText(conversation.title ?? ''),
        lastActivityAt: conversation.lastActivityAt,
        lastReadAt: conversation.lastReadAt,
        groupChat: conversation.groupChat,
        read: conversation.read,
        categories: conversation.categories,
        unreadCount: conversation.unreadCount ?? 0,
        participants,
      }],
    })
  }

  /**
   * Extract text from LinkedIn AttributedText or plain string.
   * LinkedIn API sometimes returns { text: "value" } instead of "value".
   */
  private extractText(value: unknown): string {
    if (typeof value === 'string') {
      return value
    }
    if (value && typeof value === 'object' && 'text' in value) {
      return String((value as { text: unknown }).text)
    }
    return ''
  }

  /**
   * Sync messages to Convex.
   */
  private async syncMessagesToConvex(
    conversationId: string,
    messages: Message[]
  ): Promise<void> {
    // Transform messages for Convex
    const transformedMessages = messages.map((m) => ({
      entityURN: m.entityURN,
      conversationURN: m.conversationURN || conversationId,
      text: this.extractText(m.body.text),
      deliveredAt: m.deliveredAt,
      senderURN: m.sender.entityURN,
      senderFirstName: this.extractText(
        m.sender.participantType.member?.firstName ??
        m.sender.participantType.organization?.name ??
        ''
      ),
      senderLastName: this.extractText(m.sender.participantType.member?.lastName ?? ''),
      messageBodyRenderFormat: m.messageBodyRenderFormat,
      // Map attachments from renderContent
      attachments: m.renderContent
        ?.map((rc) => {
          if (rc.file) {
            return {
              type: 'file' as const,
              name: rc.file.name,
              url: rc.file.url,
              mediaType: rc.file.mediaType,
              size: rc.file.size,
            }
          }
          if (rc.image) {
            return {
              type: 'image' as const,
              url: rc.image.url,
              width: rc.image.width,
              height: rc.image.height,
            }
          }
          if (rc.video) {
            return {
              type: 'video' as const,
              url: rc.video.url,
              thumbnailUrl: rc.video.thumbnail?.url,
              duration: rc.video.duration,
            }
          }
          if (rc.audio) {
            return {
              type: 'audio' as const,
              url: rc.audio.url,
              duration: rc.audio.duration,
            }
          }
          return null
        })
        .filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== null),
      reactions: m.reactionSummaries?.map((r) => ({
        emoji: r.emoji,
        count: r.count,
        viewerReacted: r.viewerReacted,
      })),
    }))

    await this.convexClient.mutation(api.sync.syncLinkedInMessages, {
      messages: transformedMessages,
    })
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Get current sync progress.
   */
  getProgress(): LinkedInSyncProgress {
    return { ...this.progress }
  }

  /**
   * Set token provider callback.
   */
  setTokenProvider(getAuthToken: () => Promise<string | null>): void {
    this.options.getAuthToken = getAuthToken
  }

  /**
   * Set progress callback.
   */
  setProgressCallback(onProgress: (progress: LinkedInSyncProgress) => void): void {
    this.options.onProgress = onProgress
  }

  /**
   * Set auth invalid callback.
   */
  setAuthInvalidCallback(onAuthInvalid: () => void): void {
    this.options.onAuthInvalid = onAuthInvalid
  }

  /**
   * Reset sync state (for testing or forced re-sync).
   */
  reset(): void {
    this.conversationCursors.clear()
    this.conversationSyncToken = null
    this.progress = {
      status: 'idle',
      totalConversationsSynced: 0,
      totalMessagesSynced: 0,
      realtimeConnected: false,
    }
  }

  /**
   * Update progress and notify listener.
   */
  private updateProgress(update: Partial<LinkedInSyncProgress>): void {
    this.progress = { ...this.progress, ...update }
    this.options.onProgress?.(this.progress)
  }

  /**
   * Check if error is an authentication error.
   */
  private isAuthError(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase()
      return (
        message.includes('unauthenticated') ||
        message.includes('401') ||
        message.includes('403') ||
        message.includes('unauthorized') ||
        message.includes('authentication')
      )
    }
    return false
  }
}

// ============================================================================
// Singleton
// ============================================================================

let linkedInSyncManager: LinkedInSyncManager | null = null

/**
 * Get the singleton LinkedInSyncManager instance.
 */
export function getLinkedInSyncManager(
  options?: LinkedInSyncManagerOptions
): LinkedInSyncManager {
  if (!linkedInSyncManager) {
    linkedInSyncManager = new LinkedInSyncManager(options)
  }
  return linkedInSyncManager
}
