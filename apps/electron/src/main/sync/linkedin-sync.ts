/**
 * LinkedIn Sync Manager
 * Manages background sync of LinkedIn conversations and messages to Convex.
 * Follows the SyncManager pattern from sync-manager.ts.
 *
 * TODO: Replace polling with realtime websocket strategy.
 * Reference: https://github.com/mautrix/linkedin/tree/main/pkg/linkedingo
 * The Beeper implementation uses websockets for realtime message delivery.
 */

import { ConvexHttpClient } from 'convex/browser'
import { api } from '@prm/convex'
import { electronEnv } from '@prm/env/electron'
import type { LinkedInClient } from '../linkedin-api/client'
import type { Conversation, Message } from '../linkedin-api/types'
import { getMessages, getMessagesBefore, sendMessage } from '../linkedin-api/messages'

// ============================================================================
// Constants
// ============================================================================

/** Default sync interval: 5 minutes */
const SYNC_INTERVAL_MS = 5 * 60 * 1000

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
  status: 'idle' | 'syncing' | 'error'
  lastSyncAt?: number
  totalConversationsSynced: number
  totalMessagesSynced: number
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
}

// ============================================================================
// LinkedInSyncManager
// ============================================================================

/**
 * Manages background sync of LinkedIn conversations and messages.
 * Uses polling to fetch new conversations and messages.
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

  /** Interval timer ID */
  private intervalId: NodeJS.Timeout | null = null

  /** Flag to prevent concurrent syncs */
  private isRunning = false

  /** Current sync progress */
  private progress: LinkedInSyncProgress = {
    status: 'idle',
    totalConversationsSynced: 0,
    totalMessagesSynced: 0,
  }

  /** Options passed at construction */
  private options: LinkedInSyncManagerOptions

  constructor(options: LinkedInSyncManagerOptions = {}) {
    this.options = options
    this.convexClient = new ConvexHttpClient(CONVEX_URL)
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
   * Start background sync on interval.
   * Runs immediately, then every SYNC_INTERVAL_MS (5 minutes).
   */
  start(): void {
    if (this.intervalId) {
      return
    }

    this.runSync()
    this.intervalId = setInterval(() => this.runSync(), SYNC_INTERVAL_MS)
  }

  /**
   * Stop background sync.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
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
    this.updateProgress({ status: 'syncing' })

    try {
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
        status: 'idle',
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

  /**
   * Send a message to a conversation.
   * Uses the LinkedIn API to send and syncs the result to Convex.
   */
  async sendMessage(conversationId: string, text: string): Promise<Message> {
    if (!this._client) throw new Error('Client not set')

    const message = await sendMessage(this._client, conversationId, text)

    // Sync the sent message to Convex
    await this.syncMessagesToConvex(conversationId, [message])

    this.updateProgress({
      totalMessagesSynced: this.progress.totalMessagesSynced + 1,
    })

    return message
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
