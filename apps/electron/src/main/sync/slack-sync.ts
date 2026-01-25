/**
 * Slack Sync Manager
 *
 * Manages background sync of Slack conversations and messages to Convex.
 * Uses polling for near-real-time updates (every 30 seconds).
 *
 * ## Why Polling Instead of RTM (Real-Time Messaging)
 *
 * We use xoxc- tokens (browser session tokens) extracted via Electron login.
 * These tokens provide:
 * - No Slack app installation required
 * - Full access to user's DMs and private channels
 * - Appears as the user (not a bot)
 *
 * However, xoxc- tokens do NOT support Slack's RTM (WebSocket) API:
 * - RTM requires xoxb- (bot) or xoxp- (legacy user) tokens
 * - Direct WebSocket to wss-primary.slack.com requires undocumented auth
 *
 * Polling every 30 seconds is a good tradeoff for reliability.
 *
 * ## Incremental Sync
 *
 * After the initial sync, we only fetch messages newer than `lastSyncAt`:
 * - Persisted to disk so incremental sync works across app restarts
 * - Uses a 5-minute buffer to catch any in-flight messages
 * - First sync fetches 2 years of history
 */

import { ConvexHttpClient } from 'convex/browser'
import { api } from '@prm/convex'
import {
  SlackClient,
  isTokenExpiredError,
  type SlackConversation,
  type SlackMessage,
} from '@prm/integrations'
import { isAuthError, withAuthRetry } from '../auth/auth-utils'
import { getAuthState } from '../auth/auth-manager'
import {
  getSlackCredentials,
  getAllSlackCredentials,
  saveSlackCredentials,
  deleteSlackCredentials,
  type SlackStoredCredentials,
} from '../auth/slack-credentials'
import { getSyncDebugLogger } from './sync-debug-logger'
import {
  createConvexClient,
  loadCursor,
  saveCursor,
  clearCursor,
  createSyncGuard,
  createAuthRetryOptions,
  setConvexAuth,
} from './shared'

// ============================================================================
// Constants
// ============================================================================

/** Polling interval: 30 seconds */
const POLL_INTERVAL_MS = 30 * 1000

/** Conversations to fetch per page from Slack API (max 1000, we use 100 for reliability) */
const CONVERSATIONS_PER_PAGE = 100

/** Messages to fetch per page within a conversation (Slack default limit) */
const MAX_MESSAGES_PER_CONVERSATION = 100

/**
 * Maximum pages of messages to fetch per conversation.
 * At 100 messages/page, this caps at 1000 messages per conversation.
 * This prevents infinite loops on very active channels and keeps sync times reasonable.
 * Older messages can be fetched via on-demand history loading if needed.
 */
const MAX_MESSAGE_PAGES_PER_CONVERSATION = 10

/** 0 = unlimited conversations. Set to a positive number to limit for testing. */
const MAX_TOTAL_CONVERSATIONS = 0

/**
 * Years of message history to sync on initial full sync.
 * 1 year provides good historical context for relationship insights while
 * keeping initial sync time under 10 minutes for typical workspaces.
 * Older messages won't appear in the UI but that's acceptable - recent
 * context is what matters for relationship management.
 */
const MESSAGE_HISTORY_YEARS = 1

/** Maximum number of Slack workspaces that can be connected */
const MAX_WORKSPACES = 10

/** User cache TTL: 24 hours */
const USER_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** Maximum user cache size to prevent memory leaks */
const MAX_USER_CACHE_SIZE = 10000

/** Regex to match Slack user mentions: <@U12345> or <@U12345|display_name> */
const SLACK_MENTION_REGEX = /<@(U[A-Z0-9]+)(?:\|[^>]*)?>/g

interface CachedSlackUser {
  id: string
  name: string
  realName?: string
  email?: string
  fetchedAt: number
}

function getOldestMessageTimestamp(): string {
  const yearsAgoMs = Date.now() - MESSAGE_HISTORY_YEARS * 365 * 24 * 60 * 60 * 1000
  return (yearsAgoMs / 1000).toFixed(6)
}

// ============================================================================
// Cursor State (synced to cloud via Convex)
// ============================================================================

/** State for resumable full sync - allows continuing after crash/restart */
export interface SlackFullSyncState {
  /** Position in conversation list pagination */
  conversationListCursor: string | null
  /** Conversations that have been fully synced (messages fetched) */
  completedConversations: string[]
  /** Total conversations seen so far (for progress tracking) */
  totalConversationsSeen: number
}

export interface SlackCursorState {
  conversationCursors: Record<string, string>
  conversationListCursor: string | null
  lastSyncAt: number
  teamId: string
  /** State for resumable full sync - present during full sync, cleared on completion */
  fullSyncState?: SlackFullSyncState
}

// ============================================================================
// Types
// ============================================================================

export interface SlackSyncProgress {
  status: 'idle' | 'syncing' | 'error'
  lastSyncAt?: number
  totalConversationsSynced: number
  totalMessagesSynced: number
  currentConversation?: {
    conversationId: string
    messagesInConversation: number
  }
  error?: string
  teamName?: string
}

export interface SlackSyncManagerOptions {
  onProgress?: (progress: SlackSyncProgress) => void
  teamId?: string
}

// ============================================================================
// SlackSyncManager
// ============================================================================

/**
 * Manages background sync of Slack conversations and messages.
 * Uses polling (no RTM) for reliable sync with xoxc- tokens.
 */
export class SlackSyncManager {
  private client: SlackClient | null = null
  private credentials: SlackStoredCredentials | null = null
  private convexClient: ConvexHttpClient
  private conversationCursors: Map<string, string> = new Map()
  private conversationListCursor: string | null = null
  private lastSyncAt: number = 0
  private pollIntervalId: NodeJS.Timeout | null = null
  private syncGuard = createSyncGuard()
  private progress: SlackSyncProgress = {
    status: 'idle',
    totalConversationsSynced: 0,
    totalMessagesSynced: 0,
  }
  private options: SlackSyncManagerOptions
  private teamId: string | null = null
  /** Cache of Slack user info to avoid repeated API calls */
  private userCache: Map<string, CachedSlackUser> = new Map()
  /** State for resumable full sync */
  private fullSyncState: SlackFullSyncState | null = null

  constructor(options: SlackSyncManagerOptions = {}) {
    this.options = options
    this.convexClient = createConvexClient()
    this.teamId = options.teamId ?? null
  }

  // ============================================================================
  // Properties
  // ============================================================================

  getTeamId(): string | null {
    return this.teamId ?? this.credentials?.teamId ?? null
  }

  getClient(): SlackClient | null {
    return this.client
  }

  hasCredentials(): boolean {
    return this.credentials !== null
  }

  getTeamName(): string | null {
    return this.credentials?.teamName ?? null
  }

  getUserId(): string | null {
    return this.credentials?.userId ?? null
  }

  isAuthenticated(): boolean {
    return this.credentials !== null && this.client !== null
  }

  getProgress(): SlackSyncProgress {
    return { ...this.progress }
  }

  // ============================================================================
  // Lifecycle Methods
  // ============================================================================

  async initialize(): Promise<boolean> {
    this.credentials = getSlackCredentials(this.teamId ?? undefined)
    if (!this.credentials) {
      console.log(`[SlackSync] No stored credentials${this.teamId ? ` for team ${this.teamId}` : ''}`)
      return false
    }

    if (!this.teamId) {
      this.teamId = this.credentials.teamId
    }

    this.client = new SlackClient({
      token: this.credentials.token,
      cookie: this.credentials.cookie,
    })

    // Cursor state will be loaded from cloud in start() after auth is set up
    this.updateProgress({ teamName: this.credentials.teamName })
    return true
  }

  /**
   * Initialize cursor state from cloud (Convex).
   * Must be called after Convex auth is set up.
   */
  private async initializeCursorFromCloud(): Promise<void> {
    if (!this.credentials?.teamId) return

    const cursor = await loadCursor<SlackCursorState>(this.convexClient, 'slack', this.credentials.teamId)

    if (cursor) {
      const cursorState = cursor.cursorData
      this.conversationCursors = new Map(Object.entries(cursorState.conversationCursors || {}))
      this.conversationListCursor = cursorState.conversationListCursor ?? null
      this.lastSyncAt = cursorState.lastSyncAt || 0

      // Restore full sync state if present (resumable sync)
      if (cursorState.fullSyncState) {
        this.fullSyncState = cursorState.fullSyncState
      }
    }
  }

  setCredentials(credentials: Omit<SlackStoredCredentials, 'savedAt'>): void {
    saveSlackCredentials(credentials)
    this.credentials = getSlackCredentials()

    this.client = new SlackClient({
      token: credentials.token,
      cookie: credentials.cookie,
    })
    this.updateProgress({ teamName: credentials.teamName })
  }

  /**
   * Start sync - runs initial sync then polls every 30 seconds.
   */
  async start(): Promise<void> {
    if (!this.client || !this.credentials) {
      const initialized = await this.initialize()
      if (!initialized) {
        console.log('[SlackSync] ERROR: No Slack credentials available')
        this.updateProgress({ status: 'error', error: 'Slack not connected' })
        return
      }
    }

    // Set up Convex auth using centralized auth manager
    const token = await setConvexAuth(this.convexClient)
    if (!token) {
      this.updateProgress({ status: 'error', error: 'Not authenticated' })
      return
    }

    // Validate Slack credentials
    try {
      const authResult = await this.client!.testAuth()
      if (!authResult.ok) {
        throw new Error('Slack auth test failed')
      }
      console.log(`[SlackSync] Authenticated as ${authResult.user} in ${authResult.team}`)

      // Update Slack integration status in Convex (creates if not exists)
      const authState = getAuthState()
      if (authState.user && this.credentials) {
        try {
          await this.convexClient.mutation(api.integrations.updateSlackStatus, {
            workosUserId: authState.user.id,
            teamId: this.credentials.teamId,
            teamName: this.credentials.teamName,
            userId: this.credentials.userId,
            isConnected: true,
          })
          console.log(`[SlackSync] Updated integration status for team ${this.credentials.teamName}`)
        } catch (error) {
          // Non-fatal - continue with sync even if integration update fails
          console.error('[SlackSync] Failed to update integration status:', error)
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (isTokenExpiredError(error)) {
        this.updateProgress({ status: 'error', error: 'Slack session expired' })
        return
      }
      // Update progress with error state before re-throwing
      this.updateProgress({ status: 'error', error: `Slack auth failed: ${errorMessage}` })
      throw error
    }

    // Load cursor state from cloud (now that auth is set up)
    await this.initializeCursorFromCloud()

    // Run initial full sync (non-blocking - failures won't prevent polling from starting)
    console.log('[SlackSync] Running initial sync...')
    try {
      await this.runSync()
    } catch (error) {
      // Log but don't throw - let polling retry
      console.error('[SlackSync] Initial sync failed, will retry on next poll:', error)
    }

    // Start incremental polling (uses lastSyncAt to only fetch new messages)
    console.log(`[SlackSync] Starting incremental polling (${POLL_INTERVAL_MS / 1000}s interval)`)
    this.pollIntervalId = setInterval(() => this.runSync(), POLL_INTERVAL_MS)
  }

  /**
   * Stop all sync operations.
   */
  stop(): void {
    console.log('[SlackSync] Stopping sync...')

    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId)
      this.pollIntervalId = null
    }

    this.updateProgress({ status: 'idle' })
  }

  /**
   * Disconnect and clear credentials.
   * Uses centralized auth internally for clearing cursor.
   */
  async disconnect(clearCursors: boolean = true): Promise<void> {
    const teamId = this.credentials?.teamId ?? this.teamId
    const teamName = this.credentials?.teamName ?? 'unknown'
    const userId = this.credentials?.userId ?? ''

    this.stop()

    // Update integration status to disconnected
    const authState = getAuthState()
    if (authState.user && teamId) {
      try {
        await this.convexClient.mutation(api.integrations.updateSlackStatus, {
          workosUserId: authState.user.id,
          teamId,
          teamName,
          userId,
          isConnected: false,
        })
        console.log(`[SlackSync] Marked integration as disconnected for team ${teamName}`)
      } catch (error) {
        console.error('[SlackSync] Failed to update integration status:', error)
      }
    }

    if (teamId) {
      deleteSlackCredentials(teamId)
      if (clearCursors) {
        await clearCursor(this.convexClient, 'slack', teamId)
      }
    }
    this.client = null
    this.credentials = null
    this.teamId = null
    this.reset()
  }

  /**
   * Trigger an immediate sync (e.g., after sending a message).
   * Skips if a sync is already running.
   */
  async triggerSync(): Promise<void> {
    if (this.syncGuard.isRunning()) {
      console.log('[SlackSync] Sync already running, skipping trigger')
      return
    }
    console.log('[SlackSync] Triggered immediate sync')
    await this.runSync()
  }

  // ============================================================================
  // Sync Methods
  // ============================================================================

  /**
   * Run a single sync cycle.
   * Uses incremental sync based on lastSyncAt timestamp.
   */
  async runSync(): Promise<void> {
    if (!this.syncGuard.tryStart()) return

    if (!this.client) {
      this.updateProgress({ status: 'error', error: 'Slack client not configured' })
      this.syncGuard.finish()
      return
    }

    this.updateProgress({ status: 'syncing' })

    const syncStartTime = Date.now()
    const logger = getSyncDebugLogger()
    const isFullSync = this.lastSyncAt === 0 || this.fullSyncState !== null
    logger.logSyncStart('slack', isFullSync ? 'full' : 'incremental')

    try {
      // Re-auth if needed using centralized auth
      const token = await setConvexAuth(this.convexClient)
      if (!token) {
        this.updateProgress({ status: 'error', error: 'Not authenticated' })
        logger.logSyncError('slack', 'Not authenticated')
        return
      }

      await this.syncConversations()

      // Update lastSyncAt and persist cursor state to cloud
      this.lastSyncAt = Date.now()
      await this.persistCursorState()

      this.updateProgress({
        status: 'idle',
        lastSyncAt: this.lastSyncAt,
        currentConversation: undefined,
      })

      logger.logSyncComplete('slack', {
        conversationsProcessed: this.progress.totalConversationsSynced,
        durationMs: Date.now() - syncStartTime,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[SlackSync] Sync error: ${message}`)
      logger.logSyncError('slack', message)

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
   * Sync conversations from Slack.
   * Supports resumable full sync - if interrupted, will continue from where it left off.
   */
  async syncConversations(): Promise<void> {
    if (!this.client) throw new Error('Client not set')

    const isFullSync = this.lastSyncAt === 0 || this.fullSyncState !== null
    let totalSynced = 0

    // Initialize or restore full sync state
    if (isFullSync && !this.fullSyncState) {
      // Starting a new full sync
      this.fullSyncState = {
        conversationListCursor: null,
        completedConversations: [],
        totalConversationsSeen: 0,
      }
      // Persist initial state so we can resume if interrupted
      await this.persistCursorState()
    }

    // For full sync, use the saved cursor position; for incremental, start fresh
    let cursor = isFullSync
      ? (this.fullSyncState?.conversationListCursor ?? undefined)
      : (this.conversationListCursor ?? undefined)

    const completedSet = new Set(this.fullSyncState?.completedConversations ?? [])

    function hasReachedLimit(): boolean {
      return MAX_TOTAL_CONVERSATIONS > 0 && totalSynced >= MAX_TOTAL_CONVERSATIONS
    }

    do {
      const result = await this.client.listConversations({
        types: 'im,mpim,private_channel,public_channel',
        cursor,
        limit: CONVERSATIONS_PER_PAGE,
      })

      // Track total conversations seen for progress
      if (this.fullSyncState) {
        this.fullSyncState.totalConversationsSeen += result.conversations.length
      }

      for (const conversation of result.conversations) {
        // Skip if already completed in a previous run (resumable sync)
        if (completedSet.has(conversation.id)) {
          continue
        }

        try {
          await this.syncConversationToConvex(conversation)
          await this.syncMessages(conversation.id)

          totalSynced++
          this.updateProgress({
            totalConversationsSynced: this.progress.totalConversationsSynced + 1,
          })

          // Mark conversation as completed and persist (resumable sync)
          if (this.fullSyncState) {
            this.fullSyncState.completedConversations.push(conversation.id)
            completedSet.add(conversation.id)
            // Persist after each conversation so we can resume
            await this.persistCursorState()
          }

          if (hasReachedLimit()) break
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          console.error(`[SlackSync] Error syncing conversation ${conversation.id}: ${msg}`)
          if (isAuthError(error)) {
            throw error
          }
          // For other errors, continue with next conversation
          // TODO: For resumable sync, track failed conversations separately so they
          // can be retried on next sync attempt. Add `failedConversations: string[]`
          // to SlackFullSyncState and retry them before moving to new conversations.
        }
      }

      cursor = result.nextCursor

      // Update cursor position for resumable sync
      if (this.fullSyncState) {
        this.fullSyncState.conversationListCursor = cursor ?? null
      }
      this.conversationListCursor = cursor ?? null
    } while (cursor && !hasReachedLimit())

    // Full sync complete - clear fullSyncState
    if (isFullSync) {
      this.fullSyncState = null
    }
  }

  /**
   * Sync messages for a specific conversation.
   * Uses lastSyncAt for incremental sync (only fetches new messages).
   * Paginates through all available messages up to MAX_MESSAGE_PAGES_PER_CONVERSATION pages.
   */
  async syncMessages(channelId: string): Promise<void> {
    if (!this.client) throw new Error('Client not set')

    this.updateProgress({
      currentConversation: { conversationId: channelId, messagesInConversation: 0 },
    })

    let cursor = this.conversationCursors.get(channelId)

    // INCREMENTAL SYNC: Use lastSyncAt to only fetch new messages
    // Subtract 5 minutes as buffer for any messages that may have been in-flight
    // On first sync (lastSyncAt = 0), fetch MESSAGE_HISTORY_YEARS of history
    const oldest = this.lastSyncAt > 0
      ? ((this.lastSyncAt - 5 * 60 * 1000) / 1000).toFixed(6)
      : getOldestMessageTimestamp()

    let totalMessagesSyncedForChannel = 0
    let pageCount = 0

    // Paginate through all messages, up to MAX_MESSAGE_PAGES_PER_CONVERSATION pages
    do {
      const result = await this.client.getHistory(channelId, {
        cursor,
        limit: MAX_MESSAGES_PER_CONVERSATION,
        oldest,
      })

      if (result.messages.length === 0) {
        break
      }

      await this.syncMessagesToConvex(channelId, result.messages)
      totalMessagesSyncedForChannel += result.messages.length
      pageCount++

      // Update cursor for next page
      cursor = result.nextCursor
      if (cursor) {
        this.conversationCursors.set(channelId, cursor)
      }

      this.updateProgress({
        totalMessagesSynced: this.progress.totalMessagesSynced + result.messages.length,
        currentConversation: { conversationId: channelId, messagesInConversation: totalMessagesSyncedForChannel },
      })
    } while (cursor && pageCount < MAX_MESSAGE_PAGES_PER_CONVERSATION)
  }

  // ============================================================================
  // Convex Sync Methods
  // ============================================================================

  /**
   * Resolve display name for a group DM (mpim) conversation.
   * Fetches member IDs and resolves each to their display name.
   */
  private async resolveMpimDisplayName(conversationId: string): Promise<string | undefined> {
    if (!this.client || !this.credentials) return undefined

    try {
      const { members } = await this.client.getConversationMembers(conversationId)
      if (!members || members.length === 0) return undefined

      // Filter out the current user and resolve display names
      const otherMembers = members.filter((id) => id !== this.credentials!.userId)
      const displayNames: string[] = []

      for (const memberId of otherMembers) {
        const user = await this.getSlackUser(memberId)
        if (user) {
          displayNames.push(user.name)
        }
      }

      if (displayNames.length === 0) return undefined

      // Join names with comma, truncate if too long
      const joined = displayNames.join(', ')
      return joined.length > 100 ? `${joined.slice(0, 97)}...` : joined
    } catch (error) {
      console.warn(`[SlackSync] Failed to resolve mpim display name for ${conversationId}:`, error)
      return undefined
    }
  }

  private async syncConversationToConvex(conversation: SlackConversation): Promise<void> {
    if (!this.credentials) throw new Error('No credentials')

    // Resolve display name for group DMs (mpim)
    let resolvedName = conversation.name ?? undefined
    if (conversation.is_mpim) {
      const mpimName = await this.resolveMpimDisplayName(conversation.id)
      if (mpimName) {
        resolvedName = mpimName
      }
    }

    await withAuthRetry(
      () => this.convexClient.mutation(api.sync.syncSlackConversations, {
        slackUserId: this.credentials!.userId,
        teamId: this.credentials!.teamId,
        conversations: [{
          id: conversation.id,
          name: resolvedName,
          isChannel: conversation.is_channel ?? false,
          isIm: conversation.is_im ?? false,
          isMpim: conversation.is_mpim ?? false,
          isPrivate: conversation.is_private ?? false,
          isArchived: conversation.is_archived ?? false,
          userId: conversation.user ?? undefined,
          unreadCount: conversation.unread_count ?? 0,
          lastRead: conversation.last_read ?? undefined,
          latestTs: conversation.latest?.ts,
          latestText: conversation.latest?.text,
        }],
      }),
      createAuthRetryOptions(this.convexClient)
    )
  }

  private async syncMessagesToConvex(channelId: string, messages: SlackMessage[]): Promise<void> {
    if (!this.credentials) throw new Error('No credentials')

    // Pre-fetch all message senders' user info
    const senderIds = messages
      .map((m) => m.user ?? m.bot_id)
      .filter((id): id is string => !!id && id !== 'unknown')
    await this.prefetchUsers([...new Set(senderIds)])

    // Resolve all mentions and collect mentioned users
    const allMentionedUsers = new Map<string, CachedSlackUser>()
    const transformedMessages = await Promise.all(
      messages.map(async (m) => {
        // Resolve mentions in the message text
        const { resolvedText, mentionedUsers } = await this.resolveUserMentions(m.text)

        // Collect mentioned users for contact creation
        for (const user of mentionedUsers) {
          allMentionedUsers.set(user.id, user)
        }

        // Also resolve the message sender's name (now should be in cache from prefetch)
        const senderId = m.user ?? m.bot_id ?? 'unknown'
        const senderInfo = senderId !== 'unknown' ? this.userCache.get(senderId) : null

        return {
          channelId,
          ts: m.ts,
          text: resolvedText,
          userId: senderId,
          userName: senderInfo?.name,
          threadTs: m.thread_ts,
          isThreadParent: m.reply_count !== undefined && m.reply_count > 0,
          replyCount: m.reply_count ?? 0,
          reactions: m.reactions?.map((r) => ({
            name: r.name,
            count: r.count,
            users: r.users,
          })),
        }
      })
    )

    // Convert mentioned users to format expected by Convex
    const mentionedUsersArray = Array.from(allMentionedUsers.values()).map((u) => ({
      slackUserId: u.id,
      displayName: u.name,
      realName: u.realName,
      email: u.email,
    }))

    await withAuthRetry(
      () => this.convexClient.mutation(api.sync.syncSlackNativeMessages, {
        slackUserId: this.credentials!.userId,
        teamId: this.credentials!.teamId,
        messages: transformedMessages,
        mentionedUsers: mentionedUsersArray,
      }),
      createAuthRetryOptions(this.convexClient)
    )
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  setProgressCallback(onProgress: (progress: SlackSyncProgress) => void): void {
    this.options.onProgress = onProgress
  }

  reset(): void {
    this.conversationCursors.clear()
    this.conversationListCursor = null
    this.lastSyncAt = 0
    this.userCache.clear()
    this.fullSyncState = null
    this.progress = {
      status: 'idle',
      totalConversationsSynced: 0,
      totalMessagesSynced: 0,
    }
  }

  /**
   * Persist cursor state to cloud (Convex).
   * Uses centralized auth internally.
   */
  private async persistCursorState(): Promise<void> {
    if (!this.credentials?.teamId) return

    const state: SlackCursorState = {
      conversationCursors: Object.fromEntries(this.conversationCursors),
      conversationListCursor: this.conversationListCursor,
      lastSyncAt: this.lastSyncAt,
      teamId: this.credentials.teamId,
      fullSyncState: this.fullSyncState ?? undefined,
    }

    const syncMode = this.fullSyncState !== null || this.lastSyncAt === 0 ? 'full' : 'incremental'
    await saveCursor(this.convexClient, 'slack', state, {
      syncMode,
      workspaceId: this.credentials.teamId,
    })
  }

  private updateProgress(update: Partial<SlackSyncProgress>): void {
    this.progress = { ...this.progress, ...update }
    this.options.onProgress?.(this.progress)
  }

  // ============================================================================
  // User Resolution Methods
  // ============================================================================

  /**
   * Get a Slack user by ID, using cache when available.
   * Fetches from API if not cached or cache expired.
   */
  private async getSlackUser(userId: string): Promise<CachedSlackUser | null> {
    // Check cache first
    const cached = this.userCache.get(userId)
    if (cached && Date.now() - cached.fetchedAt < USER_CACHE_TTL_MS) {
      return cached
    }

    // Fetch from API
    if (!this.client) return null

    try {
      const user = await this.client.getUserInfo(userId)
      if (!user) return null

      const cachedUser: CachedSlackUser = {
        id: user.id,
        name: user.profile.display_name || user.profile.real_name || user.name,
        realName: user.profile.real_name,
        email: user.profile.email,
        fetchedAt: Date.now(),
      }
      // Prune cache if it exceeds max size (remove oldest entries)
      if (this.userCache.size > MAX_USER_CACHE_SIZE) {
        this.pruneUserCache()
      }
      this.userCache.set(userId, cachedUser)
      return cachedUser
    } catch (error) {
      console.warn(`[SlackSync] Failed to fetch user ${userId}:`, error)
      return null
    }
  }

  /**
   * Remove oldest entries from user cache to stay under MAX_USER_CACHE_SIZE.
   * Removes entries that are expired or oldest by fetchedAt.
   */
  private pruneUserCache(): void {
    const now = Date.now()
    const entriesToRemove: string[] = []

    // First pass: remove expired entries
    for (const [id, user] of this.userCache) {
      if (now - user.fetchedAt >= USER_CACHE_TTL_MS) {
        entriesToRemove.push(id)
      }
    }

    // If still over limit, remove oldest entries
    if (this.userCache.size - entriesToRemove.length > MAX_USER_CACHE_SIZE) {
      const sortedEntries = Array.from(this.userCache.entries())
        .filter(([id]) => !entriesToRemove.includes(id))
        .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)

      // Remove oldest 25% of cache
      const removeCount = Math.ceil(sortedEntries.length * 0.25)
      for (let i = 0; i < removeCount; i++) {
        entriesToRemove.push(sortedEntries[i][0])
      }
    }

    for (const id of entriesToRemove) {
      this.userCache.delete(id)
    }
  }

  /**
   * Extract all user IDs mentioned in text.
   */
  private extractMentionedUserIds(text: string): string[] {
    const userIds: string[] = []
    let match: RegExpExecArray | null
    // Reset regex state
    SLACK_MENTION_REGEX.lastIndex = 0
    while ((match = SLACK_MENTION_REGEX.exec(text)) !== null) {
      userIds.push(match[1])
    }
    return [...new Set(userIds)] // dedupe
  }

  /**
   * Resolve all user mentions in text, replacing <@U12345> with @DisplayName.
   * Also returns the list of resolved users for contact creation.
   */
  private async resolveUserMentions(text: string): Promise<{
    resolvedText: string
    mentionedUsers: CachedSlackUser[]
  }> {
    const userIds = this.extractMentionedUserIds(text)
    if (userIds.length === 0) {
      return { resolvedText: text, mentionedUsers: [] }
    }

    // Fetch all users (in parallel)
    const userPromises = userIds.map((id) => this.getSlackUser(id))
    const users = await Promise.all(userPromises)

    // Build lookup map
    const userMap = new Map<string, CachedSlackUser>()
    const mentionedUsers: CachedSlackUser[] = []
    for (const user of users) {
      if (user) {
        userMap.set(user.id, user)
        mentionedUsers.push(user)
      }
    }

    // Replace mentions in text
    // Reset regex state
    SLACK_MENTION_REGEX.lastIndex = 0
    const resolvedText = text.replace(SLACK_MENTION_REGEX, (match, userId) => {
      const user = userMap.get(userId)
      return user ? `@${user.name}` : match // Keep original if user not found
    })

    return { resolvedText, mentionedUsers }
  }

  /**
   * Pre-populate user cache from a list of user IDs.
   * Useful for batch-loading users before processing messages.
   */
  async prefetchUsers(userIds: string[]): Promise<void> {
    const uncachedIds = userIds.filter((id) => {
      const cached = this.userCache.get(id)
      return !cached || Date.now() - cached.fetchedAt >= USER_CACHE_TTL_MS
    })

    if (uncachedIds.length === 0) return

    await Promise.all(uncachedIds.map((id) => this.getSlackUser(id)))
  }
}

// ============================================================================
// Sync Manager Registry (Multi-Workspace Support)
// ============================================================================

const slackSyncManagers: Map<string, SlackSyncManager> = new Map()
let defaultSlackSyncManager: SlackSyncManager | null = null

export function getSlackSyncManager(options?: SlackSyncManagerOptions): SlackSyncManager {
  const teamId = options?.teamId

  if (!teamId) {
    // When no teamId specified, return the single authenticated manager if there's only one
    const authenticatedManagers = Array.from(slackSyncManagers.values()).filter((m) =>
      m.isAuthenticated()
    )

    if (authenticatedManagers.length === 1) {
      return authenticatedManagers[0]
    }

    if (authenticatedManagers.length > 1) {
      throw new Error(
        `Multiple Slack workspaces connected (${authenticatedManagers.length}), but no teamId specified. ` +
          'Please specify which workspace to use.'
      )
    }

    // Fall back to default manager (may need initialization)
    if (!defaultSlackSyncManager) {
      defaultSlackSyncManager = new SlackSyncManager(options)
    }
    return defaultSlackSyncManager
  }

  let manager = slackSyncManagers.get(teamId)
  if (!manager) {
    // Check workspace limit before creating new manager
    if (slackSyncManagers.size >= MAX_WORKSPACES) {
      throw new Error(
        `Maximum number of Slack workspaces (${MAX_WORKSPACES}) reached. ` +
          'Please disconnect a workspace before adding a new one.'
      )
    }
    manager = new SlackSyncManager(options)
    slackSyncManagers.set(teamId, manager)
  }
  return manager
}

export function getAllSlackSyncManagers(): SlackSyncManager[] {
  const managers = Array.from(slackSyncManagers.values())
  if (defaultSlackSyncManager && !managers.includes(defaultSlackSyncManager)) {
    managers.push(defaultSlackSyncManager)
  }
  return managers
}

export function removeSlackSyncManager(teamId: string): void {
  const manager = slackSyncManagers.get(teamId)
  if (manager) {
    manager.stop()
    slackSyncManagers.delete(teamId)
  }
}

export async function initializeAllSlackSyncManagers(
  baseOptions?: Omit<SlackSyncManagerOptions, 'teamId'>
): Promise<SlackSyncManager[]> {
  const allCredentials = getAllSlackCredentials()
  const managers: SlackSyncManager[] = []

  for (const creds of allCredentials) {
    const manager = getSlackSyncManager({ ...baseOptions, teamId: creds.teamId })
    const initialized = await manager.initialize()
    if (initialized) {
      managers.push(manager)
      console.log(`[SlackSync] Initialized sync manager for ${creds.teamName}`)
    }
  }

  return managers
}
