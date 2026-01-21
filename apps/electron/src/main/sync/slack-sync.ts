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
import { electronEnv } from '@prm/env/electron'
import {
  SlackClient,
  isTokenExpiredError,
  type SlackConversation,
  type SlackMessage,
} from '@prm/integrations'
import {
  getSlackCredentials,
  getAllSlackCredentials,
  saveSlackCredentials,
  deleteSlackCredentials,
  type SlackStoredCredentials,
} from '../auth/slack-credentials'
import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

// ============================================================================
// Constants
// ============================================================================

/** Polling interval: 30 seconds */
const POLL_INTERVAL_MS = 30 * 1000

/** Convex URL from environment */
const CONVEX_URL = electronEnv.CONVEX_URL

const CONVERSATIONS_PER_PAGE = 100
const MAX_MESSAGES_PER_CONVERSATION = 100
const MAX_TOTAL_CONVERSATIONS = 0 // 0 = unlimited
const MESSAGE_HISTORY_YEARS = 2

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
// Cursor Persistence (incremental sync across app restarts)
// ============================================================================

export interface SlackCursorState {
  conversationCursors: Record<string, string>
  conversationListCursor: string | null
  lastSyncAt: number
  teamId: string
}

function getSlackCursorPath(teamId: string): string {
  const userDataPath = app.getPath('userData')
  return path.join(userDataPath, `slack_sync_cursor_${teamId}.json`)
}

function loadSlackCursorState(teamId: string): SlackCursorState | null {
  try {
    const cursorPath = getSlackCursorPath(teamId)
    if (fs.existsSync(cursorPath)) {
      const data = JSON.parse(fs.readFileSync(cursorPath, 'utf-8'))
      return {
        conversationCursors: data.conversationCursors || {},
        conversationListCursor: data.conversationListCursor ?? null,
        lastSyncAt: data.lastSyncAt || 0,
        teamId: data.teamId || teamId,
      }
    }
  } catch (e) {
    console.warn(`[SlackSync] Failed to load cursor state for ${teamId}:`, e)
  }
  return null
}

function saveSlackCursorState(state: SlackCursorState): void {
  try {
    const cursorPath = getSlackCursorPath(state.teamId)
    const dir = path.dirname(cursorPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(cursorPath, JSON.stringify(state, null, 2))
  } catch (e) {
    console.warn(`[SlackSync] Failed to save cursor state:`, e)
  }
}

function clearSlackCursorState(teamId: string): void {
  try {
    const cursorPath = getSlackCursorPath(teamId)
    if (fs.existsSync(cursorPath)) {
      fs.unlinkSync(cursorPath)
      console.log(`[SlackSync] Cleared cursor state for ${teamId}`)
    }
  } catch (e) {
    console.warn(`[SlackSync] Failed to clear cursor state:`, e)
  }
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
  getAuthToken?: () => Promise<string | null>
  onAuthInvalid?: () => void
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
  private isRunning = false
  private progress: SlackSyncProgress = {
    status: 'idle',
    totalConversationsSynced: 0,
    totalMessagesSynced: 0,
  }
  private options: SlackSyncManagerOptions
  private teamId: string | null = null
  private forceRefreshToken: (() => Promise<string | null>) | null = null
  /** Cache of Slack user info to avoid repeated API calls */
  private userCache: Map<string, CachedSlackUser> = new Map()

  constructor(options: SlackSyncManagerOptions = {}) {
    this.options = options
    this.convexClient = new ConvexHttpClient(CONVEX_URL)
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

    // Load persisted cursor state for incremental sync
    const cursorState = loadSlackCursorState(this.credentials.teamId)
    if (cursorState) {
      console.log(`[SlackSync] Loaded cursor state from ${new Date(cursorState.lastSyncAt).toISOString()}`)
      this.conversationCursors = new Map(Object.entries(cursorState.conversationCursors))
      this.conversationListCursor = cursorState.conversationListCursor
      this.lastSyncAt = cursorState.lastSyncAt
    }

    this.updateProgress({ teamName: this.credentials.teamName })
    return true
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

    // Set up Convex auth
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

    // Validate Slack credentials
    try {
      const authResult = await this.client!.testAuth()
      if (!authResult.ok) {
        throw new Error('Slack auth test failed')
      }
      console.log(`[SlackSync] Authenticated as ${authResult.user} in ${authResult.team}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (isTokenExpiredError(error)) {
        this.options.onAuthInvalid?.()
        this.updateProgress({ status: 'error', error: 'Slack session expired' })
        return
      }
      // Update progress with error state before re-throwing
      this.updateProgress({ status: 'error', error: `Slack auth failed: ${errorMessage}` })
      throw error
    }

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
   */
  async disconnect(clearCursors: boolean = true): Promise<void> {
    const teamId = this.credentials?.teamId ?? this.teamId
    this.stop()
    if (teamId) {
      deleteSlackCredentials(teamId)
      if (clearCursors) {
        clearSlackCursorState(teamId)
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
    if (this.isRunning) {
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
    if (this.isRunning) return

    if (!this.client) {
      this.updateProgress({ status: 'error', error: 'Slack client not configured' })
      return
    }

    this.isRunning = true
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

      // Update lastSyncAt and persist cursor state
      this.lastSyncAt = Date.now()
      this.persistCursorState()

      this.updateProgress({
        status: 'idle',
        lastSyncAt: this.lastSyncAt,
        currentConversation: undefined,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[SlackSync] Sync error: ${message}`)

      if (isTokenExpiredError(error)) {
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
   * Sync conversations from Slack.
   */
  async syncConversations(): Promise<void> {
    if (!this.client) throw new Error('Client not set')

    let cursor = this.conversationListCursor ?? undefined
    let totalSynced = 0

    const limitLabel = MAX_TOTAL_CONVERSATIONS > 0 ? MAX_TOTAL_CONVERSATIONS : 'unlimited'
    console.log(`[SlackSync] Starting conversation sync (limit: ${limitLabel})`)

    const hasReachedLimit = (): boolean =>
      MAX_TOTAL_CONVERSATIONS > 0 && totalSynced >= MAX_TOTAL_CONVERSATIONS

    do {
      const result = await this.client.listConversations({
        types: 'im,mpim,private_channel,public_channel',
        cursor,
        limit: CONVERSATIONS_PER_PAGE,
      })

      console.log(`[SlackSync] Fetched ${result.conversations.length} conversations`)

      for (const conversation of result.conversations) {
        try {
          await this.syncConversationToConvex(conversation)
          await this.syncMessages(conversation.id)

          totalSynced++
          this.updateProgress({
            totalConversationsSynced: this.progress.totalConversationsSynced + 1,
          })

          if (hasReachedLimit()) break
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          console.error(`[SlackSync] Error syncing conversation ${conversation.id}: ${msg}`)
          if (this.isConvexAuthError(error)) {
            throw error
          }
        }
      }

      cursor = result.nextCursor
      this.conversationListCursor = cursor ?? null
    } while (cursor && !hasReachedLimit())

    console.log(`[SlackSync] Conversation sync complete: ${totalSynced} conversations synced`)
  }

  /**
   * Sync messages for a specific conversation.
   * Uses lastSyncAt for incremental sync (only fetches new messages).
   */
  async syncMessages(channelId: string): Promise<void> {
    if (!this.client) throw new Error('Client not set')

    this.updateProgress({
      currentConversation: { conversationId: channelId, messagesInConversation: 0 },
    })

    const cursor = this.conversationCursors.get(channelId)

    // INCREMENTAL SYNC: Use lastSyncAt to only fetch new messages
    // Subtract 5 minutes as buffer for any messages that may have been in-flight
    // On first sync (lastSyncAt = 0), fetch MESSAGE_HISTORY_YEARS of history
    const oldest = this.lastSyncAt > 0
      ? ((this.lastSyncAt - 5 * 60 * 1000) / 1000).toFixed(6)
      : getOldestMessageTimestamp()

    const result = await this.client.getHistory(channelId, {
      cursor,
      limit: MAX_MESSAGES_PER_CONVERSATION,
      oldest,
    })

    if (result.messages.length === 0) {
      return
    }

    await this.syncMessagesToConvex(channelId, result.messages)

    if (result.nextCursor) {
      this.conversationCursors.set(channelId, result.nextCursor)
    }

    this.updateProgress({
      totalMessagesSynced: this.progress.totalMessagesSynced + result.messages.length,
      currentConversation: { conversationId: channelId, messagesInConversation: result.messages.length },
    })
  }

  // ============================================================================
  // Convex Sync Methods
  // ============================================================================

  setForceRefreshCallback(callback: () => Promise<string | null>): void {
    this.forceRefreshToken = callback
  }

  private async ensureFreshAuth(): Promise<boolean> {
    if (this.options.getAuthToken) {
      const token = await this.options.getAuthToken()
      if (token) {
        this.convexClient.setAuth(token)
        return true
      } else {
        this.options.onAuthInvalid?.()
        return false
      }
    }
    return true
  }

  private isConvexAuthError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return (
      message.includes('InvalidAuthHeader') ||
      message.includes('Token expired') ||
      message.includes('Could not validate token')
    )
  }

  private async withAuthRetry<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (this.isConvexAuthError(error) && this.forceRefreshToken) {
        console.log('[SlackSync] Auth error detected, force refreshing token...')
        const newToken = await this.forceRefreshToken()
        if (newToken) {
          this.convexClient.setAuth(newToken)
          return await operation()
        } else {
          this.options.onAuthInvalid?.()
        }
      }
      throw error
    }
  }

  private async syncConversationToConvex(conversation: SlackConversation): Promise<void> {
    if (!this.credentials) throw new Error('No credentials')

    if (!(await this.ensureFreshAuth())) {
      throw new Error('Auth token refresh failed')
    }

    await this.withAuthRetry(() => this.convexClient.mutation(api.sync.syncSlackConversations, {
      slackUserId: this.credentials!.userId,
      conversations: [{
        id: conversation.id,
        name: conversation.name ?? undefined,
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
    }))
  }

  private async syncMessagesToConvex(channelId: string, messages: SlackMessage[]): Promise<void> {
    if (!this.credentials) throw new Error('No credentials')

    if (!(await this.ensureFreshAuth())) {
      throw new Error('Auth token refresh failed')
    }

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

    await this.withAuthRetry(() => this.convexClient.mutation(api.sync.syncSlackNativeMessages, {
      slackUserId: this.credentials!.userId,
      messages: transformedMessages,
      mentionedUsers: mentionedUsersArray,
    }))
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  setTokenProvider(getAuthToken: () => Promise<string | null>): void {
    this.options.getAuthToken = getAuthToken
  }

  setProgressCallback(onProgress: (progress: SlackSyncProgress) => void): void {
    this.options.onProgress = onProgress
  }

  setAuthInvalidCallback(onAuthInvalid: () => void): void {
    this.options.onAuthInvalid = onAuthInvalid
  }

  reset(): void {
    this.conversationCursors.clear()
    this.conversationListCursor = null
    this.lastSyncAt = 0
    this.userCache.clear()
    this.progress = {
      status: 'idle',
      totalConversationsSynced: 0,
      totalMessagesSynced: 0,
    }
  }

  private persistCursorState(): void {
    if (!this.credentials?.teamId) return

    const state: SlackCursorState = {
      conversationCursors: Object.fromEntries(this.conversationCursors),
      conversationListCursor: this.conversationListCursor,
      lastSyncAt: this.lastSyncAt,
      teamId: this.credentials.teamId,
    }
    saveSlackCursorState(state)
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

    if (entriesToRemove.length > 0) {
      console.log(`[SlackSync] Pruned ${entriesToRemove.length} entries from user cache`)
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

    console.log(`[SlackSync] Prefetching ${uncachedIds.length} users...`)
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
