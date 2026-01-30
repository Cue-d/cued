/**
 * LinkedIn Sync Manager
 * Manages background sync of LinkedIn conversations and messages to Convex.
 * Uses realtime SSE for live updates with periodic sync as fallback.
 */

import { ConvexHttpClient } from 'convex/browser'
import { api } from '@cued/convex'
import { normalizeConversationURN } from '@cued/shared'
import { withAuthRetry } from '../../auth/auth-utils'
import type { LinkedInClient } from './api/client'
import type { Conversation, Message, EventHandlers } from './api/types'
export type { Message } from './api/types'
import { getMessages, getMessagesBefore } from './api/messages'
import { getProfilesByMemberIds } from './api/profile'
import { getSyncDebugLogger, type FilteredMessageLog } from '../../sync/debug-logger'
import {
  createConvexClient,
  loadCursor,
  saveCursor,
  clearCursor,
  createAuthRetryOptions,
  setConvexAuth,
} from '../../sync/cursor'
import { createSyncGuard } from '../../sync/guard'

// ============================================================================
// Constants
// ============================================================================

/**
 * Fallback sync interval when realtime connection fails: 5 minutes.
 * This ensures messages are still synced even if realtime SSE disconnects.
 * 5 minutes balances freshness with API rate limit concerns.
 */
const FALLBACK_SYNC_INTERVAL_MS = 5 * 60 * 1000

/**
 * Periodic full sync interval even when realtime is connected: 30 minutes.
 * Acts as a safety net to catch any messages that realtime may have missed.
 * LinkedIn's realtime can occasionally drop events, so this ensures consistency.
 */
const FULL_SYNC_INTERVAL_MS = 30 * 60 * 1000

/**
 * Maximum conversations to sync per cycle.
 * LinkedIn's API returns conversations sorted by last activity, so 50 covers
 * recent activity well. Higher values slow down each sync cycle and increase
 * API load without much benefit since we run syncs frequently.
 */
const MAX_CONVERSATIONS_PER_SYNC = 50

/**
 * Maximum messages to fetch per conversation in a single sync.
 * LinkedIn's pagination returns ~20 messages per page, so 100 = ~5 pages.
 * This captures recent context without overloading the API on initial sync.
 * Historical messages are fetched via getMessagesBefore() pagination.
 */
const MAX_MESSAGES_PER_CONVERSATION = 100

/**
 * Maximum contacts to resolve usernames for in a single batch.
 * LinkedIn's API accepts up to 50 profiles at a time.
 */
const USERNAME_RESOLUTION_BATCH_SIZE = 50

// ============================================================================
// Cursor State (synced to cloud via Convex)
// ============================================================================

/**
 * Full sync state for resumable syncs.
 * Tracks progress through initial full sync so it can be resumed if interrupted.
 */
export interface LinkedInFullSyncState {
  /** Conversation IDs that have been fully synced */
  completedConversations: string[]
  /** Total conversations seen so far */
  totalConversationsSeen: number
  /** Sync token from conversation list (for pagination) */
  conversationListSyncToken: string | null
}

interface LinkedInCursorState {
  conversationCursors: Record<string, string>
  conversationSyncToken: string | null
  lastSyncAt: number
  /** Full sync progress for resumable syncs */
  fullSyncState?: LinkedInFullSyncState
}

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

  /** Per-conversation pagination cursors (in-memory, synced to cloud) */
  private conversationCursors: Map<string, string> = new Map()

  /** Sync token for incremental conversation fetches */
  private conversationSyncToken: string | null = null

  /** Last successful sync timestamp */
  private lastSyncAt: number = 0

  /** Fallback polling interval timer ID */
  private fallbackIntervalId: NodeJS.Timeout | null = null

  /** Full sync interval timer ID */
  private fullSyncIntervalId: NodeJS.Timeout | null = null

  /** Sync guard to prevent concurrent runs */
  private syncGuard = createSyncGuard()

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

  /** Full sync state for resumable syncs */
  private fullSyncState: LinkedInFullSyncState | null = null

  constructor(options: LinkedInSyncManagerOptions = {}) {
    this.options = options
    this.convexClient = createConvexClient()
    this.useRealtime = options.useRealtime !== false // default true
  }

  // ============================================================================
  // Properties
  // ============================================================================

  /** Get the LinkedIn client */
  get client(): LinkedInClient | null {
    return this._client
  }

  /** Set or clear the LinkedIn client */
  setClient(client: LinkedInClient | null): void {
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

    // Set up auth using centralized auth manager
    const token = await setConvexAuth(this.convexClient)
    if (!token) {
      this.updateProgress({ status: 'error', error: 'Not authenticated' })
      return
    }

    // Fetch user profile to get userEntityURN (needed for isFromMe detection and title filtering)
    if (!this._client.userEntityURN) {
      try {
        console.log('[LinkedInSync] Fetching user profile...')
        await this._client.fetchSelf()
        console.log(`[LinkedInSync] User URN: ${this._client.userEntityURN}`)
      } catch (error) {
        console.warn('[LinkedInSync] Failed to fetch user profile:', error)
        // Continue anyway - isFromMe will be inaccurate but sync will work
      }
    }

    // Load cursor state from cloud
    await this.initializeCursorFromCloud()

    // Run initial full sync
    console.log('[LinkedInSync] Running initial sync...')
    await this.runSync()

    // Always start fallback polling as a safety net
    this.startPolling()

    if (this.useRealtime) {
      // Also start realtime connection for lower-latency updates
      await this.startRealtime()
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
  // Cloud Cursor Methods
  // ============================================================================

  /**
   * Initialize cursor state from cloud (Convex).
   * Must be called after Convex auth is set up.
   */
  private async initializeCursorFromCloud(): Promise<void> {
    const cursor = await loadCursor<LinkedInCursorState>(this.convexClient, 'linkedin')

    if (cursor) {
      const cursorState = cursor.cursorData
      this.conversationCursors = new Map(Object.entries(cursorState.conversationCursors || {}))
      this.conversationSyncToken = cursorState.conversationSyncToken ?? null
      this.lastSyncAt = cursorState.lastSyncAt || 0

      // Restore full sync state if present (for resumable syncs)
      if (cursorState.fullSyncState) {
        this.fullSyncState = cursorState.fullSyncState
      }
    }
  }

  /**
   * Persist cursor state to cloud (Convex).
   * Uses centralized auth internally.
   */
  private async persistCursorState(): Promise<void> {
    const state: LinkedInCursorState = {
      conversationCursors: Object.fromEntries(this.conversationCursors),
      conversationSyncToken: this.conversationSyncToken,
      lastSyncAt: this.lastSyncAt,
      fullSyncState: this.fullSyncState ?? undefined,
    }

    const syncMode = this.fullSyncState ? 'full' : this.lastSyncAt === 0 ? 'full' : 'incremental'
    await saveCursor(this.convexClient, 'linkedin', state, { syncMode })
  }

  /**
   * Clear cursor from cloud (for disconnect/reset).
   * Uses centralized auth internally.
   */
  async clearCursorFromCloud(): Promise<void> {
    await clearCursor(this.convexClient, 'linkedin')
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
        this.updateProgress({ status: 'realtime', realtimeConnected: true })
        // Keep fallback polling running as a safety net in case realtime
        // connects but doesn't actually receive events
      },
      onDisconnected: () => {
        this.updateProgress({ realtimeConnected: false })
        // Polling is already running as safety net, no action needed
      },
      onMessage: (message) => {
        this.handleRealtimeMessage(message)
      },
      onConversationUpdate: (conversation) => {
        this.handleRealtimeConversation(conversation)
      },
      onTypingIndicator: () => {
        // Could emit typing events to UI if needed
      },
      onHeartbeat: () => {
        // Connection is alive
      },
    }

    this._client.setEventHandlers(handlers)

    try {
      await this._client.startRealtime()
    } catch {
      // Polling is already running as safety net, no additional action needed
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
      // Realtime message sync failed, will be picked up by next full sync
      const msg = error instanceof Error ? error.message : String(error)
      getSyncDebugLogger().logSyncError('linkedin', `Realtime message sync failed: ${msg}`, {
        messageURN: message.entityURN,
        conversationURN: message.conversationURN,
      })
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
      // Realtime conversation sync failed, will be picked up by next full sync
      const msg = error instanceof Error ? error.message : String(error)
      getSyncDebugLogger().logSyncError('linkedin', `Realtime conversation sync failed: ${msg}`, {
        conversationURN: conversation.entityURN,
      })
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

  // ============================================================================
  // Sync Methods
  // ============================================================================

  /**
   * Sync messages for a single conversation.
   * Used after sending a message to quickly fetch just that conversation's messages.
   * Much faster than runSync() which syncs all conversations.
   */
  async syncConversationMessages(conversationId: string): Promise<void> {
    if (!this._client) {
      console.warn('[LinkedInSync] Cannot sync conversation - client not configured')
      return
    }

    const token = await setConvexAuth(this.convexClient)
    if (!token) {
      console.warn('[LinkedInSync] Cannot sync conversation - not authenticated')
      return
    }

    try {
      await this.syncMessages(conversationId)
    } catch (error) {
      console.error(`[LinkedInSync] syncConversationMessages failed for ${conversationId}:`, error)
      throw error
    }
  }

  /**
   * Sync a single sent message directly to Convex.
   * Used after sending a message when we already have the response,
   * avoiding the need to re-fetch via getMessages() which can fail.
   */
  async syncSentMessage(message: Message): Promise<void> {
    const token = await setConvexAuth(this.convexClient)
    if (!token) {
      console.warn('[LinkedInSync] Cannot sync sent message - not authenticated')
      return
    }

    try {
      await this.syncMessagesToConvex(message.conversationURN, [message])
    } catch (error) {
      console.error(`[LinkedInSync] syncSentMessage failed for ${message.entityURN}:`, error)
      throw error
    }
  }

  /**
   * Run a single sync cycle.
   * Fetches conversations, then messages for each conversation.
   */
  async runSync(): Promise<void> {
    if (!this.syncGuard.tryStart()) return

    if (!this._client) {
      this.updateProgress({ status: 'error', error: 'LinkedIn client not configured' })
      this.syncGuard.finish()
      return
    }

    this.updateProgress({ status: 'syncing' })

    const syncStartTime = Date.now()
    const logger = getSyncDebugLogger()
    const isFullSync = this.lastSyncAt === 0 || this.fullSyncState !== null
    logger.logSyncStart('linkedin', isFullSync ? 'full' : 'incremental')

    try {
      // Re-auth if needed using centralized auth
      const token = await setConvexAuth(this.convexClient)
      if (!token) {
        this.updateProgress({ status: 'error', error: 'Not authenticated' })
        logger.logSyncError('linkedin', 'Not authenticated')
        return
      }

      await this.syncConversations()

      // Update lastSyncAt and persist cursor state to cloud
      this.lastSyncAt = Date.now()
      await this.persistCursorState()

      // Resolve missing usernames (public identifiers) for contacts
      // This runs after sync completes to fill in vanity URLs for messaging contacts
      await this.resolveUsernamesAfterSync()

      this.updateProgress({
        status: this.progress.realtimeConnected ? 'realtime' : 'idle',
        lastSyncAt: this.lastSyncAt,
        currentConversation: undefined,
      })

      logger.logSyncComplete('linkedin', {
        conversationsProcessed: this.progress.totalConversationsSynced,
        durationMs: Date.now() - syncStartTime,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[LinkedInSync] Sync error: ${message}`)
      logger.logSyncError('linkedin', message)

      this.updateProgress({
        status: 'error',
        error: message,
        currentConversation: undefined,
      })
    } finally {
      this.syncGuard.finish()
    }
  }

  /**
   * Resolve missing usernames (public identifiers) for LinkedIn contacts.
   * Contacts from messaging sync often only have URN handles.
   * This method looks them up via LinkedIn's profile API and adds username handles.
   */
  async resolveUsernamesAfterSync(): Promise<void> {
    if (!this._client) {
      console.log('[LinkedInSync] No client, skipping username resolution')
      return
    }

    try {
      // Query Convex for contacts missing usernames
      const result = await this.convexClient.query(
        api.sync.findLinkedInContactsMissingUsernames,
        { limit: USERNAME_RESOLUTION_BATCH_SIZE }
      )

      const contacts = result.contacts
      if (!contacts || contacts.length === 0) {
        return
      }

      console.log(`[LinkedInSync] Resolving ${contacts.length} missing usernames...`)

      // Extract member IDs for lookup
      const memberIds = contacts.map((c) => c.memberId)

      // Batch lookup profiles via LinkedIn API
      const profiles = await getProfilesByMemberIds(this._client, memberIds)

      // Build resolutions array with successful lookups
      const resolutions = profiles
        .map((profile, i) =>
          profile?.publicIdentifier
            ? { memberId: contacts[i].memberId, publicIdentifier: profile.publicIdentifier }
            : null
        )
        .filter((r): r is NonNullable<typeof r> => r !== null)

      if (resolutions.length === 0) {
        console.log('[LinkedInSync] No usernames to resolve')
        return
      }

      // Update Convex with resolved usernames
      const updateResult = await this.convexClient.mutation(
        api.sync.addLinkedInUsernames,
        { resolutions }
      )

      console.log(
        `[LinkedInSync] Username resolution: ${updateResult.added} added, ${updateResult.skipped} skipped`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[LinkedInSync] Username resolution failed: ${message}`)
      // Don't throw - this is a non-critical operation
    }
  }

  /**
   * Sync conversations from LinkedIn.
   * Uses sync token for incremental updates.
   * Supports resumable full syncs by tracking completed conversations.
   */
  async syncConversations(): Promise<void> {
    if (!this._client) throw new Error('Client not set')

    const isFullSync = this.lastSyncAt === 0 || this.fullSyncState !== null

    // Initialize full sync state if this is a fresh full sync
    if (isFullSync && !this.fullSyncState) {
      this.fullSyncState = {
        completedConversations: [],
        totalConversationsSeen: 0,
        conversationListSyncToken: null,
      }
    }

    // Build set of completed conversations for fast lookup
    const completedSet = new Set(this.fullSyncState?.completedConversations ?? [])

    // For incremental sync: DON'T use sync token - always fetch recent conversations
    // to ensure we catch new messages. The sync token can cause missed messages if
    // LinkedIn's API is slow to mark conversations as "updated".
    // For full sync: use sync token for resumability.
    const syncToken = isFullSync
      ? this.fullSyncState?.conversationListSyncToken ?? undefined
      : undefined // Don't use sync token for incremental - always fetch recent

    const result = await this._client.getConversations(syncToken)

    // Update sync tokens
    if (result.syncToken) {
      if (isFullSync && this.fullSyncState) {
        this.fullSyncState.conversationListSyncToken = result.syncToken
      }
      this.conversationSyncToken = result.syncToken
    }

    const conversationsToSync = result.conversations.slice(0, MAX_CONVERSATIONS_PER_SYNC)

    if (isFullSync && this.fullSyncState) {
      this.fullSyncState.totalConversationsSeen += conversationsToSync.length
    }

    for (const conversation of conversationsToSync) {
      // Normalize conversation ID for consistent cursor tracking
      const conversationId = normalizeConversationURN(conversation.entityURN)

      // Skip already-completed conversations when resuming
      if (completedSet.has(conversationId)) {
        continue
      }

      try {
        await this.syncConversationToConvex(conversation)

        // Use embedded messages from the conversation response if available
        // This avoids making a separate getMessages() call which can fail with
        // "Internal error fetching data from downstream"
        if (conversation.messages?.elements && conversation.messages.elements.length > 0) {
          const embeddedMessages = conversation.messages.elements
          await this.syncMessagesToConvex(conversationId, embeddedMessages)
          this.updateProgress({
            totalMessagesSynced: this.progress.totalMessagesSynced + embeddedMessages.length,
          })

          // Fetch message history using getMessagesBefore() anchored from oldest embedded message
          if (this._client && embeddedMessages.length > 0) {
            const oldestEmbedded = embeddedMessages.reduce((a, b) =>
              a.deliveredAt < b.deliveredAt ? a : b
            )
            await this.fetchMessageHistory(conversationId, oldestEmbedded.deliveredAt)
          }
        } else {
          // Fallback: try to fetch messages directly (may fail)
          await this.syncMessages(conversationId)
        }

        this.updateProgress({
          totalConversationsSynced: this.progress.totalConversationsSynced + 1,
        })

        // Mark conversation as completed and persist state
        if (isFullSync && this.fullSyncState) {
          this.fullSyncState.completedConversations.push(conversationId)
          // Persist after each conversation for resumability
          await this.persistCursorState()
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error(`[LinkedInSync] Error syncing conversation ${conversationId}: ${msg}`)
        // Don't mark as completed on error - will retry on resume
      }
    }

    // Clear full sync state when complete (no more conversations to sync)
    if (isFullSync && conversationsToSync.length < MAX_CONVERSATIONS_PER_SYNC) {
      this.fullSyncState = null
    }
  }

  /**
   * Fetch message history for a conversation using getMessagesBefore().
   * This uses the messengerMessagesByAnchorTimestamp GraphQL query which
   * may work when messengerMessagesByConversation fails.
   *
   * @param conversationId - The conversation URN
   * @param anchorTimestamp - Timestamp to fetch messages before (in ms)
   */
  private async fetchMessageHistory(conversationId: string, anchorTimestamp: number): Promise<void> {
    if (!this._client) return

    const maxIterations = 10 // Limit pagination to avoid infinite loops
    let currentTimestamp = anchorTimestamp

    for (let i = 0; i < maxIterations; i++) {
      try {
        const result = await getMessagesBefore(this._client, conversationId, currentTimestamp)

        if (result.messages.length === 0) {
          break
        }

        await this.syncMessagesToConvex(conversationId, result.messages)

        this.updateProgress({
          totalMessagesSynced: this.progress.totalMessagesSynced + result.messages.length,
        })

        // Get oldest message timestamp for next iteration
        const oldestMessage = result.messages.reduce((a, b) =>
          a.deliveredAt < b.deliveredAt ? a : b
        )
        currentTimestamp = oldestMessage.deliveredAt

        // If we got fewer messages than requested, we've reached the end
        if (result.messages.length < 20) {
          break
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.warn(`[LinkedInSync] History fetch failed for ${conversationId}: ${msg}`)
        break
      }
    }
  }

  /**
   * Sync messages for a specific conversation.
   * Always fetches newest messages first (no cursor) to catch new messages.
   * On full sync, also paginates through history using cursor.
   *
   * NOTE: LinkedIn's messengerMessagesByConversation GraphQL query can fail with
   * "Internal error fetching data from downstream". In that case, messages should
   * be obtained from the embedded messages in getConversations() response instead.
   */
  async syncMessages(conversationId: string): Promise<void> {
    if (!this._client) throw new Error('Client not set')

    // Normalize conversation ID for consistent cursor tracking
    const normalizedConversationId = normalizeConversationURN(conversationId)

    this.updateProgress({
      currentConversation: { conversationId: normalizedConversationId, messagesInConversation: 0 },
    })

    let totalSynced = 0

    // Always fetch newest messages first (no cursor) to catch new messages
    let newestResult
    try {
      // Note: Use original conversationId for API call (LinkedIn expects their format)
      newestResult = await getMessages(this._client, conversationId, undefined)
    } catch (error) {
      // getMessages() can fail with "Internal error fetching data from downstream"
      // Skip this conversation - embedded messages should have been used instead
      const msg = error instanceof Error ? error.message : String(error)
      console.warn(`[LinkedInSync] getMessages failed for ${normalizedConversationId}: ${msg}`)
      return
    }

    if (newestResult.messages.length > 0) {
      await this.syncMessagesToConvex(normalizedConversationId, newestResult.messages)
      totalSynced += newestResult.messages.length
    }

    // Paginate through older messages using timestamp-based pagination.
    // This is more reliable than index-based cursors which can have off-by-one issues.
    // Messages are assumed to be sorted by deliveredAt descending (newest first).
    const PAGE_SIZE = 20
    const MAX_PAGES = 10 // ~200 messages max per sync

    if (newestResult.messages.length >= PAGE_SIZE) {
      let oldestTimestamp = newestResult.messages[newestResult.messages.length - 1]?.deliveredAt

      for (let page = 0; page < MAX_PAGES && oldestTimestamp; page++) {
        try {
          const historyResult = await getMessagesBefore(this._client, conversationId, oldestTimestamp)

          if (historyResult.messages.length === 0) {
            break
          }

          await this.syncMessagesToConvex(normalizedConversationId, historyResult.messages)
          totalSynced += historyResult.messages.length

          if (historyResult.messages.length < PAGE_SIZE) {
            break
          }

          oldestTimestamp = historyResult.messages[historyResult.messages.length - 1]?.deliveredAt
        } catch {
          console.warn(`[LinkedInSync] Pagination failed for ${normalizedConversationId}, stopping`)
          break
        }
      }
    }

    this.updateProgress({
      totalMessagesSynced: this.progress.totalMessagesSynced + totalSynced,
      currentConversation: { conversationId: normalizedConversationId, messagesInConversation: totalSynced },
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

    await withAuthRetry(
      // @ts-ignore - TS2589: Convex's generated types hit TypeScript's depth limit
      () => this.convexClient.mutation(api.sync.syncLinkedInConversations, {
        conversations: [{
          // Normalize conversation URN to canonical format to prevent duplicates
          entityURN: normalizeConversationURN(conversation.entityURN),
          title: this.extractText(conversation.title ?? ''),
          lastActivityAt: conversation.lastActivityAt,
          lastReadAt: conversation.lastReadAt,
          groupChat: conversation.groupChat,
          read: conversation.read,
          categories: conversation.categories,
          unreadCount: conversation.unreadCount ?? 0,
          participants,
        }],
        // Pass user URN for self-filtering from title and isFromMe detection
        userURN: this._client?.userEntityURN ?? undefined,
      }),
      createAuthRetryOptions(this.convexClient)
    )
  }

  /**
   * Extract text from LinkedIn AttributedText or plain string.
   * LinkedIn API sometimes returns { text: "value" } instead of "value".
   */
  private extractText(value: unknown): string {
    if (typeof value === 'string') return value
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
    const logger = getSyncDebugLogger()

    // Pre-filter RECALLED/SYSTEM messages and log them
    const filteredLocally: FilteredMessageLog[] = []
    const messagesToSync = messages.filter((m) => {
      if (m.messageBodyRenderFormat === 'RECALLED' || m.messageBodyRenderFormat === 'SYSTEM') {
        filteredLocally.push({
          platform: 'linkedin',
          messageId: m.entityURN,
          filterReason: m.messageBodyRenderFormat.toLowerCase(),
          senderName: `${this.extractText(m.sender.participantType.member?.firstName ?? '')} ${this.extractText(m.sender.participantType.member?.lastName ?? '')}`.trim(),
          contentPreview: this.extractText(m.body.text),
          conversationId,
        })
        return false
      }
      return true
    })

    // Log locally filtered messages
    if (filteredLocally.length > 0) {
      logger.logFilteredBatch('linkedin', filteredLocally)
    }

    if (messagesToSync.length === 0) {
      return
    }

    // Transform messages for Convex
    // Normalize conversation URN to canonical format to prevent duplicates
    const normalizedConversationId = normalizeConversationURN(conversationId)
    const transformedMessages = messagesToSync.map((m) => ({
      entityURN: m.entityURN,
      conversationURN: normalizeConversationURN(m.conversationURN || normalizedConversationId),
      text: this.extractText(m.body.text),
      deliveredAt: m.deliveredAt,
      senderURN: m.sender.entityURN,
      senderProfileUrl: m.sender.participantType.member?.profileUrl || undefined,
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

    await withAuthRetry(
      () => this.convexClient.mutation(api.sync.syncLinkedInMessages, {
        messages: transformedMessages,
        userURN: this._client?.userEntityURN ?? undefined,
      }),
      createAuthRetryOptions(this.convexClient)
    )
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
   * Set progress callback.
   */
  setProgressCallback(onProgress: (progress: LinkedInSyncProgress) => void): void {
    this.options.onProgress = onProgress
  }

  /**
   * Reset sync state (for testing or forced re-sync).
   * Optionally clears cloud cursor as well.
   */
  async reset(clearCloud: boolean = false): Promise<void> {
    this.conversationCursors.clear()
    this.conversationSyncToken = null
    this.lastSyncAt = 0
    this.fullSyncState = null
    this.progress = {
      status: 'idle',
      totalConversationsSynced: 0,
      totalMessagesSynced: 0,
      realtimeConnected: false,
    }

    if (clearCloud) {
      await this.clearCursorFromCloud()
    }
  }

  /**
   * Update progress and notify listener.
   */
  private updateProgress(update: Partial<LinkedInSyncProgress>): void {
    this.progress = { ...this.progress, ...update }
    this.options.onProgress?.(this.progress)
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
