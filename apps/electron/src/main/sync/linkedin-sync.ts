/**
 * LinkedIn Sync Manager
 * Manages background sync of LinkedIn conversations and messages to Convex.
 * Follows the SyncManager pattern from sync-manager.ts.
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
      console.log('[LinkedInSyncManager] Already running')
      return
    }

    console.log('[LinkedInSyncManager] Starting background sync...')

    // Run initial sync immediately
    this.runSync()

    // Schedule recurring syncs
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
    console.log('[LinkedInSyncManager] Stopped background sync')
  }

  // ============================================================================
  // Sync Methods
  // ============================================================================

  /**
   * Run a single sync cycle.
   * Fetches conversations, then messages for each conversation.
   */
  async runSync(): Promise<void> {
    if (this.isRunning) {
      console.log('[LinkedInSyncManager] Sync already in progress, skipping')
      return
    }

    if (!this._client) {
      console.warn('[LinkedInSyncManager] No LinkedIn client set')
      this.updateProgress({
        status: 'error',
        error: 'LinkedIn client not configured',
      })
      return
    }

    this.isRunning = true
    this.updateProgress({ status: 'syncing' })

    try {
      // Refresh Convex auth if available
      if (this.options.getAuthToken) {
        const token = await this.options.getAuthToken()
        if (token) {
          this.convexClient.setAuth(token)
        } else {
          console.warn('[LinkedInSyncManager] No Convex auth token available')
          this.options.onAuthInvalid?.()
          this.updateProgress({
            status: 'error',
            error: 'Not authenticated',
          })
          return
        }
      }

      // Sync conversations
      await this.syncConversations()

      this.updateProgress({
        status: 'idle',
        lastSyncAt: Date.now(),
        currentConversation: undefined,
      })

      console.log(
        `[LinkedInSyncManager] Sync complete: ${this.progress.totalConversationsSynced} conversations, ${this.progress.totalMessagesSynced} messages`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[LinkedInSyncManager] Sync error:', message)

      // Check for auth errors
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

    // Store new sync token for next incremental fetch
    if (result.syncToken) {
      this.conversationSyncToken = result.syncToken
    }

    console.log(
      `[LinkedInSyncManager] Fetched ${result.conversations.length} conversations`
    )

    // Process each conversation
    for (const conversation of result.conversations.slice(
      0,
      MAX_CONVERSATIONS_PER_SYNC
    )) {
      try {
        // Sync conversation to Convex
        await this.syncConversationToConvex(conversation)

        // Sync messages for this conversation
        await this.syncMessages(conversation.entityURN)

        this.updateProgress({
          totalConversationsSynced: this.progress.totalConversationsSynced + 1,
        })
      } catch (error) {
        console.error(
          `[LinkedInSyncManager] Error syncing conversation ${conversation.entityURN}:`,
          error
        )
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
      currentConversation: {
        conversationId,
        messagesInConversation: 0,
      },
    })

    // Get existing cursor for this conversation
    const cursor = this.conversationCursors.get(conversationId)

    // Fetch messages
    const result = await getMessages(this._client, conversationId, cursor)

    console.log(
      `[LinkedInSyncManager] Fetched ${result.messages.length} messages for ${conversationId}`
    )

    if (result.messages.length === 0) {
      return
    }

    // Sync messages to Convex
    await this.syncMessagesToConvex(conversationId, result.messages)

    // Update cursor for next fetch
    if (result.metadata?.start !== undefined && result.metadata?.count !== undefined) {
      const nextCursor = String(result.metadata.start + result.metadata.count)
      this.conversationCursors.set(conversationId, nextCursor)
    }

    this.updateProgress({
      totalMessagesSynced:
        this.progress.totalMessagesSynced + result.messages.length,
      currentConversation: {
        conversationId,
        messagesInConversation: result.messages.length,
      },
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
    // Transform conversation for Convex
    const participants = conversation.conversationParticipants.map((p) => ({
      entityURN: p.entityURN,
      firstName: p.participantType.member?.firstName ?? p.participantType.organization?.name ?? '',
      lastName: p.participantType.member?.lastName ?? '',
      profileUrl: p.participantType.member?.profileUrl ?? p.participantType.organization?.pageUrl ?? '',
      headline: p.participantType.member?.headline,
      pictureUrl: p.participantType.member?.picture?.url ?? p.participantType.organization?.logoUrl,
    }))

    // Call Convex mutation
    // Note: The actual Convex mutation will be created in task 4.2
    // For now we log and prepare the data structure
    console.log(
      `[LinkedInSyncManager] Syncing conversation ${conversation.entityURN} with ${participants.length} participants`
    )

    // TODO: Uncomment when Convex mutations are available (task 4.2)
    // await this.convexClient.mutation(api.sync.linkedin.syncLinkedInConversations, {
    //   conversations: [{
    //     entityURN: conversation.entityURN,
    //     title: conversation.title,
    //     lastActivityAt: conversation.lastActivityAt,
    //     lastReadAt: conversation.lastReadAt,
    //     groupChat: conversation.groupChat,
    //     read: conversation.read,
    //     categories: conversation.categories,
    //     unreadCount: conversation.unreadCount ?? 0,
    //     participants,
    //   }],
    // })
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
      text: m.body.text,
      deliveredAt: m.deliveredAt,
      senderURN: m.sender.entityURN,
      senderFirstName:
        m.sender.participantType.member?.firstName ??
        m.sender.participantType.organization?.name ??
        '',
      senderLastName: m.sender.participantType.member?.lastName ?? '',
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
        .filter(Boolean),
      reactions: m.reactionSummaries?.map((r) => ({
        emoji: r.emoji,
        count: r.count,
        viewerReacted: r.viewerReacted,
      })),
    }))

    console.log(
      `[LinkedInSyncManager] Syncing ${transformedMessages.length} messages for ${conversationId}`
    )

    // TODO: Uncomment when Convex mutations are available (task 4.2)
    // await this.convexClient.mutation(api.sync.linkedin.syncLinkedInMessages, {
    //   messages: transformedMessages,
    // })
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
    console.log('[LinkedInSyncManager] Reset sync state')
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
