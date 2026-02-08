/**
 * Twitter Sync Manager
 *
 * Syncs Twitter/X conversations and messages to Convex.
 * Bootstrap + polling flow:
 * - Load /messages page and initial inbox state
 * - Poll user_updates with cursor for incremental changes
 */

import { ConvexHttpClient } from 'convex/browser'
import { api } from '@cued/convex'
import { withAuthRetry } from '../../auth/auth-utils'
import { getSyncDebugLogger } from '../../sync/debug-logger'
import {
  createConvexClient,
  loadCursor,
  saveCursor,
  clearCursor,
  createAuthRetryOptions,
  setConvexAuth,
} from '../../sync/cursor'
import { createSyncGuard } from '../../sync/guard'
import type {
  DMRequestQuery,
  TwitterClient,
  TwitterConversation,
  TwitterInboxData,
  TwitterMessage,
  TwitterUser,
} from './api'
import { defaultDMRequestQuery, parseTwitterEvent } from './api'
import { isAuthError, isRateLimitError, isStaleCursorError } from './api/errors'
import { TwitterStreamClient } from './api/stream'
import type { TwitterScraper } from './scraper'

// ============================================================================
// Cursor State
// ============================================================================

interface TwitterContactsCursorState {
  lastSyncAt: number
  knownFollowerHandles: string[]
  knownFollowingHandles: string[]
  knownMutualHandles: string[]
}

interface TwitterCursorState {
  pollingCursor: string
  lastSyncAt: number
  contacts?: TwitterContactsCursorState
}

// ============================================================================
// Types
// ============================================================================

export interface TwitterSyncProgress {
  status: 'idle' | 'syncing' | 'error'
  lastSyncAt?: number
  totalConversationsSynced: number
  totalMessagesSynced: number
  totalContactsSynced: number
  error?: string
}

export interface TwitterSyncManagerOptions {
  onProgress?: (progress: TwitterSyncProgress) => void
}

interface SyncInboxResult {
  conversationsSynced: number
  messagesSynced: number
  contactsSynced: number
}

/** Message payload for the syncTwitterMessages mutation. */
interface SyncMessageInput {
  messageId: string
  conversationId: string
  text: string
  sentAt: number
  senderId: string
  senderScreenName?: string
  senderName?: string
  senderProfileImageUrl?: string
  requestId?: string
}

/** 24 hour cooldown between contacts syncs */
const CONTACTS_SYNC_COOLDOWN_MS = 24 * 60 * 60 * 1000

/** Rate limit sleep between paginated API calls (mautrix uses 0) */
const API_SLEEP_MS = 0
/** Maximum inbox pages to fetch during full sync */
const MAX_INBOX_PAGES = 50
/** Maximum message history pages per conversation */
const MAX_MESSAGE_PAGES = 100
/** Messages per Convex mutation call */
const MESSAGE_BATCH_SIZE = 200

// ============================================================================
// TwitterSyncManager
// ============================================================================

export class TwitterSyncManager {
  private _client: TwitterClient | null = null
  private convexClient: ConvexHttpClient
  private syncGuard = createSyncGuard()
  private pollingCursor = ''
  private lastSyncAt = 0
  private contactsCursor: TwitterContactsCursorState | undefined
  private streamClient: TwitterStreamClient | null = null
  private activeConversationId = ''
  private includeActiveConversation = false

  private progress: TwitterSyncProgress = {
    status: 'idle',
    totalConversationsSynced: 0,
    totalMessagesSynced: 0,
    totalContactsSynced: 0,
  }

  constructor(private options: TwitterSyncManagerOptions = {}) {
    this.convexClient = createConvexClient()
  }

  get client(): TwitterClient | null {
    return this._client
  }

  setClient(client: TwitterClient | null): void {
    this._client = client
  }

  getProgress(): TwitterSyncProgress {
    return { ...this.progress }
  }

  async clearCursorFromCloud(): Promise<void> {
    await clearCursor(this.convexClient, 'twitter')
  }

  async reset(clearCloud = false): Promise<void> {
    this.pollingCursor = ''
    this.lastSyncAt = 0
    this.contactsCursor = undefined
    this.progress = {
      status: 'idle',
      totalConversationsSynced: 0,
      totalMessagesSynced: 0,
      totalContactsSynced: 0,
    }

    if (clearCloud) {
      await this.clearCursorFromCloud()
    }
  }

  stop(): void {
    this.stopStreaming()
    this.updateProgress({ status: 'idle' })
  }

  /**
   * Set the active conversation for SSE streaming (mautrix pattern).
   * SSE watches ONE conversation at a time; polling handles all conversations.
   */
  setActiveConversation(conversationId: string): void {
    if (!this._client) return
    this.activeConversationId = conversationId
    this.ensureStreaming()
    this.streamClient?.setActiveConversation(conversationId)
    // Short-circuit: trigger immediate poll (mautrix pattern)
    void this.runSync()
  }

  stopStreaming(): void {
    this.streamClient?.stop()
    this.streamClient = null
  }

  private ensureStreaming(): void {
    if (!this._client || !this.activeConversationId) return

    if (!this.streamClient) {
      this.streamClient = new TwitterStreamClient(this._client, (event) => {
        if (event.type === 'dm_update') {
          console.log(`[TwitterSync] SSE dm_update for ${event.conversationId}`)
          void this.runSync()
        }
      })
      this.streamClient.setActiveConversation(this.activeConversationId)
    }
  }

  async runSync(): Promise<void> {
    if (!this.syncGuard.tryStart()) return

    const logger = getSyncDebugLogger()

    if (!this._client) {
      this.updateProgress({ status: 'error', error: 'Twitter client not configured' })
      this.syncGuard.finish()
      return
    }

    if (!this._client.isAuthenticated()) {
      this.updateProgress({ status: 'error', error: 'Not authenticated with Twitter' })
      this.syncGuard.finish()
      return
    }

    this.updateProgress({ status: 'syncing', error: undefined })

    const syncStartTime = Date.now()
    const isFullSync = this.lastSyncAt === 0
    logger.logSyncStart('twitter', isFullSync ? 'full' : 'incremental')

    try {
      const token = await setConvexAuth(this.convexClient)
      if (!token) {
        this.updateProgress({ status: 'error', error: 'Not authenticated' })
        logger.logSyncError('twitter', 'Not authenticated')
        return
      }

      await this.initializeCursorFromCloud()

      // Initialize session once (loads HTML, parses tokens/animations/scripts)
      // to enable valid transaction signing on API calls.
      // Must NOT re-initialize every cycle — re-loading the page invalidates
      // the server-side polling cursor, causing error 34 on every incremental sync.
      if (!this._client.isSessionInitialized()) {
        await this._client.initializeSession()
      }

      if (!this.pollingCursor || this.lastSyncAt === 0) {
        // ── Full sync: discover all conversations + backfill message history ──
        await this._client.getAccountSettings()

        const { conversations, users, pollingCursor } = await this.fetchAllInboxConversations()

        if (pollingCursor) {
          this.pollingCursor = pollingCursor
        }

        // Backfill message history for each 1:1 high-quality conversation
        const eligibleConvs = conversations.filter((c) => this.isOneToOneHighQuality(c))
        console.log(`[TwitterSync] Backfilling ${eligibleConvs.length} of ${conversations.length} conversations`)

        for (let i = 0; i < eligibleConvs.length; i++) {
          const conv = eligibleConvs[i]
          const msgCount = await this.backfillConversationMessages(conv.conversation_id, users)

          this.updateProgress({
            totalMessagesSynced: this.progress.totalMessagesSynced + msgCount,
          })

          // Persist cursor every 10 conversations for crash resilience
          if ((i + 1) % 10 === 0) {
            this.lastSyncAt = Date.now()
            await this.persistCursorState()
          }
        }

        // Refresh cursor after backfill — the original cursor from inbox_initial_state
        // will have expired during the long backfill process. Re-fetch to get a fresh
        // cursor so incremental sync doesn't immediately hit error 34.
        console.log('[TwitterSync] Refreshing cursor after backfill')
        await this.refreshPollingCursor()

        // Sync inbox users as contacts (DM participants)
        const userId = this._client.getCurrentUserId()
        const contacts = Object.values(users)
          .filter((user) => user.id_str && user.screen_name && user.id_str !== userId)
          .map((user) => ({
            name: user.name || `@${user.screen_name}`,
            handle: user.screen_name,
            userId: user.id_str,
            bio: user.description ?? null,
          }))

        if (contacts.length > 0) {
          const contactsResult = await withAuthRetry(
            () =>
              this.convexClient.mutation(api.sync.syncTwitterContacts, { contacts }),
            createAuthRetryOptions(this.convexClient)
          )
          const contactsSynced = (contactsResult.newContacts ?? 0) + (contactsResult.updatedContacts ?? 0)
          this.updateProgress({
            totalContactsSynced: this.progress.totalContactsSynced + contactsSynced,
          })
        }
      } else {
        // ── Incremental sync: poll with cursor via getDMUserUpdates ──
        console.log('[TwitterSync] Incremental sync polling with cursor')
        const query = defaultDMRequestQuery()
        query.cursor = this.pollingCursor

        try {
          const response = await this._client.getDMUserUpdates(query)
          const userEvents = response.user_events

          if (userEvents) {
            const entryCount = userEvents.entries?.length ?? 0
            const cursorChanged = userEvents.cursor && userEvents.cursor !== this.pollingCursor
            console.log(`[TwitterSync] Incremental poll: ${entryCount} entries, cursor changed: ${!!cursorChanged}`)

            // Update polling cursor from user_events (NOT inbox_initial_state)
            if (cursorChanged) {
              this.pollingCursor = userEvents.cursor!
              this._client.pollingCursor = userEvents.cursor!
            }

            const result = await this.syncUserEvents(userEvents)
            this.accumulateSyncResult(result)
          }
        } catch (error) {
          if (isStaleCursorError(error)) {
            // Error 34: cursor expired. Re-fetch initial inbox state to get a
            // fresh cursor. Do NOT reset lastSyncAt — messages already exist in
            // the DB, so a full re-backfill would just waste API calls and
            // return 0 new messages (preventing action creation).
            console.warn('[TwitterSync] Stale cursor (error 34), refreshing from inbox state')
            try {
              await this.refreshPollingCursor({ syncMessages: true })
              await this.persistCursorState()
            } catch (refreshError) {
              console.warn('[TwitterSync] Failed to refresh cursor:', refreshError)
            }
            this.updateProgress({ status: 'idle', lastSyncAt: this.lastSyncAt })
            return
          }
          throw error
        }
      }

      this.lastSyncAt = Date.now()
      await this.persistCursorState()

      this.updateProgress({
        status: 'idle',
        lastSyncAt: this.lastSyncAt,
      })

      logger.logSyncComplete('twitter', {
        conversationsProcessed: this.progress.totalConversationsSynced,
        messagesProcessed: this.progress.totalMessagesSynced,
        contactsCreated: this.progress.totalContactsSynced,
        durationMs: Date.now() - syncStartTime,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const stack = error instanceof Error ? error.stack : undefined

      if (isAuthError(error)) {
        logger.logSyncError('twitter', `Auth error: ${message}`)
        this.updateProgress({ status: 'error', error: `Authentication failed: ${message}` })
      } else if (isRateLimitError(error)) {
        logger.logSyncError('twitter', `Rate limited: ${message}`)
        this.updateProgress({ status: 'error', error: `Rate limited — will retry next cycle` })
      } else {
        logger.logSyncError('twitter', message)
        if (stack) {
          console.error('[TwitterSync] Full stack trace:', stack)
        }
        this.updateProgress({ status: 'error', error: message })
      }
    } finally {
      this.syncGuard.finish()
    }
  }

  /**
   * Sync Twitter contacts by scraping followers/following and computing mutuals.
   * Only syncs new mutuals (not previously known) via cursor diffing.
   * Enforces 24h cooldown between scrapes.
   */
  async syncContacts(scraper: TwitterScraper): Promise<{ contactsSynced: number; skipped: boolean }> {
    const token = await setConvexAuth(this.convexClient)
    if (!token) {
      console.warn('[TwitterSync] syncContacts: not authenticated with Convex')
      return { contactsSynced: 0, skipped: true }
    }
    if (!this._client) {
      console.warn('[TwitterSync] syncContacts: Twitter client not configured')
      return { contactsSynced: 0, skipped: true }
    }

    // Load cursor from cloud if not yet in memory (e.g., first call after restart).
    // The contacts sync runs in phase 1, before messages sync which calls
    // initializeCursorFromCloud() — so we must load it here ourselves.
    if (!this.contactsCursor) {
      try {
        await this.initializeCursorFromCloud()
      } catch (error) {
        console.warn('[TwitterSync] Failed to load contacts cursor from cloud:', error instanceof Error ? error.message : error)
      }
    }

    // Check in-memory cooldown first (survives cloud cursor load failures)
    const inMemoryLastSync = this.contactsCursor?.lastSyncAt
    if (inMemoryLastSync) {
      const elapsed = Date.now() - inMemoryLastSync
      if (elapsed < CONTACTS_SYNC_COOLDOWN_MS) {
        console.log(
          `[TwitterSync] Contacts sync skipped - ${Math.round((CONTACTS_SYNC_COOLDOWN_MS - elapsed) / 3600000)}h remaining in cooldown`
        )
        return { contactsSynced: 0, skipped: true }
      }
    }

    // Fall back to cloud cursor for cooldown check
    let contactsCursorFromCloud: TwitterContactsCursorState | undefined
    try {
      const cursor = await loadCursor<TwitterCursorState>(this.convexClient, 'twitter')
      contactsCursorFromCloud = cursor?.cursorData?.contacts
    } catch (error) {
      console.warn('[TwitterSync] Failed to load cursor for cooldown check:', error instanceof Error ? error.message : error)
    }

    if (contactsCursorFromCloud?.lastSyncAt) {
      const elapsed = Date.now() - contactsCursorFromCloud.lastSyncAt
      if (elapsed < CONTACTS_SYNC_COOLDOWN_MS) {
        console.log(
          `[TwitterSync] Contacts sync skipped - ${Math.round((CONTACTS_SYNC_COOLDOWN_MS - elapsed) / 3600000)}h remaining in cooldown`
        )
        return { contactsSynced: 0, skipped: true }
      }
    }

    // Get screen name for scraping
    let screenName: string | undefined
    try {
      screenName = await this._client.getScreenName()
    } catch (err) {
      console.warn('[TwitterSync] Failed to get screen name from account settings:', err)
    }
    if (!screenName) {
      console.error('[TwitterSync] Cannot determine screen name for contacts sync')
      return { contactsSynced: 0, skipped: true }
    }

    console.log(`[TwitterSync] Starting contacts sync for @${screenName}`)

    // Pass known handles to scraper for early termination
    const knownFollowerHandles = new Set(
      contactsCursorFromCloud?.knownFollowerHandles ?? this.contactsCursor?.knownFollowerHandles ?? []
    )
    const knownFollowingHandles = new Set(
      contactsCursorFromCloud?.knownFollowingHandles ?? this.contactsCursor?.knownFollowingHandles ?? []
    )

    const result = await scraper.scrapeFollowersFollowing(screenName, {
      knownFollowerHandles: knownFollowerHandles.size > 0 ? knownFollowerHandles : undefined,
      knownFollowingHandles: knownFollowingHandles.size > 0 ? knownFollowingHandles : undefined,
    })
    const mutualHandles = new Set(result.mutuals.map((u) => u.screenName.toLowerCase()))

    const knownFromCloud = contactsCursorFromCloud?.knownMutualHandles ?? []
    const knownFromMemory = this.contactsCursor?.knownMutualHandles ?? []
    const knownMutualHandles = new Set(knownFromCloud.length > 0 ? knownFromCloud : knownFromMemory)
    const newMutuals = result.mutuals.filter((u) => !knownMutualHandles.has(u.screenName.toLowerCase()))

    let knownSource = 'none'
    if (knownFromCloud.length > 0) knownSource = 'cloud'
    else if (knownFromMemory.length > 0) knownSource = 'memory'

    console.log(
      `[TwitterSync] Mutuals: ${result.mutuals.length} total, ${newMutuals.length} new (known: ${knownMutualHandles.size} from ${knownSource})`
    )

    let contactsSynced = 0
    if (newMutuals.length > 0) {
      const contacts = newMutuals.map((u) => ({
        name: u.name || `@${u.screenName}`,
        handle: u.screenName,
        bio: u.bio,
      }))

      const syncResult = await withAuthRetry(
        () =>
          this.convexClient.mutation(api.sync.syncTwitterContacts, {
            contacts,
          }),
        createAuthRetryOptions(this.convexClient)
      )

      contactsSynced = (syncResult.newContacts ?? 0) + (syncResult.updatedContacts ?? 0)
    }

    // Update in-memory contacts cursor and persist full state
    this.contactsCursor = {
      lastSyncAt: Date.now(),
      knownFollowerHandles: result.followers.map((u) => u.screenName.toLowerCase()),
      knownFollowingHandles: result.following.map((u) => u.screenName.toLowerCase()),
      knownMutualHandles: Array.from(mutualHandles),
    }

    await this.persistCursorState()

    this.updateProgress({
      totalContactsSynced: this.progress.totalContactsSynced + contactsSynced,
    })

    console.log(`[TwitterSync] Contacts sync complete: ${contactsSynced} synced`)
    return { contactsSynced, skipped: false }
  }

  async syncSentMessage(message: TwitterMessage): Promise<void> {
    const token = await setConvexAuth(this.convexClient)
    if (!token || !this._client) {
      console.warn('[TwitterSync] syncSentMessage: skipped — not authenticated or client not configured')
      return
    }

    const sender = this.resolveSender(message.message_data.sender_id)
    const messageId = message.message_data.id || message.id

    await withAuthRetry(
      () =>
        this.convexClient.mutation(api.sync.syncTwitterMessages, {
          messages: [{
            messageId,
            conversationId: message.conversation_id,
            text: message.message_data.text ?? '',
            sentAt: parseSnowflakeMs(messageId),
            senderId: message.message_data.sender_id,
            senderScreenName: sender.screenName,
            senderName: sender.name,
            senderProfileImageUrl: sender.profileImageUrl,
            requestId: message.request_id,
          }],
          twitterUserId: this._client!.getCurrentUserId() || undefined,
        }),
      createAuthRetryOptions(this.convexClient)
    )
  }

  private isOneToOneHighQuality(conv: TwitterConversation): boolean {
    return conv.type === 'ONE_TO_ONE' && !conv.low_quality
  }

  /**
   * Paginate through all inbox pages and sync each page to Convex as we go.
   * Returns accumulated conversations, users, and the polling cursor.
   */
  private async fetchAllInboxConversations(): Promise<{
    conversations: TwitterConversation[]
    users: Record<string, TwitterUser>
    pollingCursor: string
  }> {
    const allConversations: TwitterConversation[] = []
    const allUsers: Record<string, TwitterUser> = {}

    // Page 1: initial inbox state
    const initialResponse = await this._client!.getInitialInboxState(defaultDMRequestQuery())
    const initialInbox = initialResponse.inbox_initial_state
    if (!initialInbox) {
      return { conversations: [], users: {}, pollingCursor: '' }
    }

    const pollingCursor = initialInbox.cursor ?? ''
    if (pollingCursor) {
      this._client!.pollingCursor = pollingCursor
    }

    // Sync page 1 to Convex (contacts synced once at end of full sync)
    const result = await this.syncInboxData(initialInbox, { syncContacts: false })
    this.accumulateSyncResult(result)

    Object.assign(allUsers, initialInbox.users ?? {})
    allConversations.push(...Object.values(initialInbox.conversations ?? {}))

    // Check if more pages exist
    let hasMore = initialInbox.inbox_timelines?.trusted?.status === 'HAS_MORE'
    let nextMaxId = initialInbox.inbox_timelines?.trusted?.min_entry_id

    let page = 1
    while (hasMore && nextMaxId && page < MAX_INBOX_PAGES) {
      page++
      await sleep(API_SLEEP_MS)

      console.log(`[TwitterSync] Fetching inbox page ${page} (max_id: ${nextMaxId})`)

      const query = defaultDMRequestQuery()
      query.max_id = nextMaxId

      const pageResponse = await this._client!.fetchTrustedThreads(query)
      const pageInbox = pageResponse.inbox_timeline
      if (!pageInbox) break

      // Sync this page to Convex immediately (contacts synced once at end of full sync)
      const pageResult = await this.syncInboxData(pageInbox, { syncContacts: false })
      this.accumulateSyncResult(pageResult)

      Object.assign(allUsers, pageInbox.users ?? {})
      allConversations.push(...Object.values(pageInbox.conversations ?? {}))

      hasMore = pageInbox.inbox_timelines?.trusted?.status === 'HAS_MORE'
      nextMaxId = pageInbox.inbox_timelines?.trusted?.min_entry_id

      console.log(
        `[TwitterSync] Page ${page}: ${Object.keys(pageInbox.conversations ?? {}).length} conversations`
      )
    }

    console.log(`[TwitterSync] Inbox pagination complete: ${allConversations.length} total conversations across ${page} pages`)

    return { conversations: allConversations, users: allUsers, pollingCursor }
  }

  /**
   * Backfill full message history for a single conversation by paginating
   * through conversation history pages.
   */
  private async backfillConversationMessages(
    conversationId: string,
    users: Record<string, TwitterUser>
  ): Promise<number> {
    const userId = this._client!.getCurrentUserId()
    let totalSynced = 0
    let nextMaxId: string | undefined

    for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
      try {
        await sleep(API_SLEEP_MS)

        const query: DMRequestQuery = {
          ...defaultDMRequestQuery(),
          ...(nextMaxId ? { max_id: nextMaxId } : {}),
        }

        const response = await this._client!.fetchConversationContext(
          conversationId,
          query,
          'FETCH_DM_CONVERSATION_HISTORY'
        )

        const timeline = response.conversation_timeline
        if (!timeline) {
          console.log(`[TwitterSync] backfill ${conversationId} page ${page}: no conversation_timeline in response`)
          break
        }

        // Merge any new users from this page
        Object.assign(users, timeline.users ?? {})

        // Extract messages from entries
        const timelineEntries = timeline.entries ?? []
        const messages: SyncMessageInput[] = []
        for (const entry of timelineEntries) {
          const parsed = parseTwitterEvent(entry)
          if (parsed.type !== 'message') continue

          const event = parsed.data
          const messageId = event.message_data.id || event.id
          if (!messageId) continue

          const sender = this.resolveSender(event.message_data.sender_id, users)
          messages.push({
            messageId,
            conversationId: event.conversation_id,
            text: event.message_data.text ?? '',
            sentAt: parseSnowflakeMs(messageId),
            senderId: event.message_data.sender_id,
            senderScreenName: sender.screenName,
            senderName: sender.name,
            senderProfileImageUrl: sender.profileImageUrl,
            requestId: event.request_id,
          })
        }

        if (page === 0 && timelineEntries.length > 0 && messages.length === 0) {
          console.log(`[TwitterSync] backfill ${conversationId}: ${timelineEntries.length} entries but 0 messages, first entry keys: ${firstEntryKeys(timelineEntries)}`)
        }

        // Send in batches
        let pageNewMessages = 0
        for (let i = 0; i < messages.length; i += MESSAGE_BATCH_SIZE) {
          const batch = messages.slice(i, i + MESSAGE_BATCH_SIZE)
          const result = await withAuthRetry(
            () =>
              this.convexClient.mutation(api.sync.syncTwitterMessages, {
                messages: batch,
                twitterUserId: userId || undefined,
              }),
            createAuthRetryOptions(this.convexClient)
          )
          const batchNew = result.newMessages ?? 0
          totalSynced += batchNew
          pageNewMessages += batchNew
        }

        // Early exit: if this page had messages but all already exist in DB,
        // older pages will also be fully synced (messages are returned newest-first)
        if (messages.length > 0 && pageNewMessages === 0) {
          console.log(`[TwitterSync] backfill ${conversationId}: page ${page} had ${messages.length} msgs, all already synced — skipping older pages`)
          break
        }

        // Check if more pages exist
        const status = timeline.status
        const minEntryId = timeline.min_entry_id
        if (status !== 'HAS_MORE' || !minEntryId) {
          if (page === 0) {
            console.log(`[TwitterSync] backfill ${conversationId}: ${timelineEntries.length} entries, ${messages.length} messages, status=${status ?? 'none'}`)
          }
          break
        }

        nextMaxId = minEntryId
      } catch (error) {
        if (isAuthError(error) || isRateLimitError(error)) {
          throw error
        }
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[TwitterSync] Error backfilling ${conversationId}: ${message}`)
        break
      }
    }

    return totalSynced
  }

  /**
   * Fetch a fresh polling cursor from the inbox initial state endpoint.
   * Optionally syncs any messages included in the inbox snapshot.
   */
  private async refreshPollingCursor(options?: { syncMessages?: boolean }): Promise<boolean> {
    const response = await this._client!.getInitialInboxState(defaultDMRequestQuery())
    const inbox = response.inbox_initial_state
    if (!inbox?.cursor) {
      console.warn('[TwitterSync] No cursor in refresh response')
      return false
    }

    this.pollingCursor = inbox.cursor
    this._client!.pollingCursor = inbox.cursor
    console.log(`[TwitterSync] Fresh polling cursor obtained (length=${inbox.cursor.length})`)

    if (options?.syncMessages) {
      const result = await this.syncInboxData(inbox, { syncContacts: false })
      this.accumulateSyncResult(result)
    }

    return true
  }

  private async initializeCursorFromCloud(): Promise<void> {
    const cursor = await loadCursor<TwitterCursorState>(this.convexClient, 'twitter')

    if (cursor) {
      this.pollingCursor = cursor.cursorData.pollingCursor || this.pollingCursor
      this.lastSyncAt = cursor.cursorData.lastSyncAt || this.lastSyncAt
      this.contactsCursor = cursor.cursorData.contacts ?? this.contactsCursor
      console.log(`[TwitterSync] Loaded cursor from cloud: lastSyncAt=${this.lastSyncAt}, hasContacts=${!!this.contactsCursor}`)
    } else {
      console.log('[TwitterSync] No cursor in cloud — starting fresh')
    }
  }

  private async persistCursorState(): Promise<void> {
    const state: TwitterCursorState = {
      pollingCursor: this.pollingCursor,
      lastSyncAt: this.lastSyncAt,
      contacts: this.contactsCursor,
    }

    await saveCursor(this.convexClient, 'twitter', state, {
      syncMode: this.lastSyncAt === 0 ? 'full' : 'incremental',
    })
  }

  private async syncInboxData(inbox: TwitterInboxData, { syncContacts = true } = {}): Promise<SyncInboxResult> {
    if (!this._client) return { conversationsSynced: 0, messagesSynced: 0, contactsSynced: 0 }

    const userId = this._client.getCurrentUserId()
    const users = inbox.users ?? {}
    const conversations = Object.values(inbox.conversations ?? {})

    const conversationResult = await withAuthRetry(
      () =>
        this.convexClient.mutation(api.sync.syncTwitterConversations, {
          conversations: conversations.map((conversation) =>
            this.transformConversation(conversation, users)
          ),
          twitterUserId: userId || undefined,
        }),
      createAuthRetryOptions(this.convexClient)
    )

    // Extract messages from event entries
    const entries = inbox.entries ?? []
    const typeCounts: Record<string, number> = {}
    const messages: SyncMessageInput[] = []
    for (const entry of entries) {
      const parsed = parseTwitterEvent(entry)
      typeCounts[parsed.type] = (typeCounts[parsed.type] ?? 0) + 1
      if (parsed.type !== 'message') continue

      const event = parsed.data
      const messageId = event.message_data.id || event.id
      if (!messageId) continue

      const sender = this.resolveSender(event.message_data.sender_id, users)
      messages.push({
        messageId,
        conversationId: event.conversation_id,
        text: event.message_data.text ?? '',
        sentAt: parseSnowflakeMs(messageId),
        senderId: event.message_data.sender_id,
        senderScreenName: sender.screenName,
        senderName: sender.name,
        senderProfileImageUrl: sender.profileImageUrl,
        requestId: event.request_id,
      })
    }

    if (entries.length > 0) {
      console.log(`[TwitterSync] syncInboxData: ${entries.length} entries -> ${messages.length} messages, types: ${JSON.stringify(typeCounts)}`)
      if (messages.length === 0) {
        console.log(`[TwitterSync] First entry keys: ${firstEntryKeys(entries)}`)
      }
    }

    let messagesSynced = 0
    if (messages.length > 0) {
      const messageResult = await withAuthRetry(
        () =>
          this.convexClient.mutation(api.sync.syncTwitterMessages, {
            messages,
            twitterUserId: userId || undefined,
          }),
        createAuthRetryOptions(this.convexClient)
      )

      messagesSynced = messageResult.newMessages ?? 0
      console.log(`[TwitterSync] syncInboxData: ${messages.length} sent to Convex -> ${messagesSynced} new`)
    }

    let contactsSynced = 0
    if (syncContacts) {
      const contacts = Object.values(users)
        .filter((user) => user.id_str && user.screen_name && user.id_str !== userId)
        .map((user) => ({
          name: user.name || `@${user.screen_name}`,
          handle: user.screen_name,
          userId: user.id_str,
          bio: user.description ?? null,
        }))

      if (contacts.length > 0) {
        const contactsResult = await withAuthRetry(
          () =>
            this.convexClient.mutation(api.sync.syncTwitterContacts, {
              contacts,
            }),
          createAuthRetryOptions(this.convexClient)
        )

        contactsSynced = (contactsResult.newContacts ?? 0) + (contactsResult.updatedContacts ?? 0)
      }
    }

    return {
      conversationsSynced: conversationResult.conversationsCount ?? conversations.length,
      messagesSynced,
      contactsSynced,
    }
  }

  /**
   * Process user_events from getDMUserUpdates polling response.
   * Unlike syncInboxData, this filters to ONE_TO_ONE high-quality conversations
   * and handles message_delete/message_edit events.
   */
  private async syncUserEvents(userEvents: TwitterInboxData): Promise<SyncInboxResult> {
    if (!this._client) return { conversationsSynced: 0, messagesSynced: 0, contactsSynced: 0 }

    const userId = this._client.getCurrentUserId()
    const users = userEvents.users ?? {}

    // Sync any conversations included in the update
    const conversations = Object.values(userEvents.conversations ?? {})
      .filter((c) => this.isOneToOneHighQuality(c))
    let conversationsSynced = 0

    if (conversations.length > 0) {
      const conversationResult = await withAuthRetry(
        () =>
          this.convexClient.mutation(api.sync.syncTwitterConversations, {
            conversations: conversations.map((conversation) =>
              this.transformConversation(conversation, users)
            ),
            twitterUserId: userId || undefined,
          }),
        createAuthRetryOptions(this.convexClient)
      )
      conversationsSynced = conversationResult.conversationsCount ?? conversations.length
    }

    // Extract messages from event entries
    const messages: SyncMessageInput[] = []
    for (const entry of userEvents.entries ?? []) {
      const parsed = parseTwitterEvent(entry)

      if (parsed.type === 'message') {
        const event = parsed.data
        const messageId = event.message_data.id || event.id
        if (!messageId) continue

        // Skip group/low-quality conversations
        const conv = userEvents.conversations?.[event.conversation_id]
        if (conv && !this.isOneToOneHighQuality(conv)) continue

        const sender = this.resolveSender(event.message_data.sender_id, users)
        messages.push({
          messageId,
          conversationId: event.conversation_id,
          text: event.message_data.text ?? '',
          sentAt: parseSnowflakeMs(messageId),
          senderId: event.message_data.sender_id,
          senderScreenName: sender.screenName,
          senderName: sender.name,
          senderProfileImageUrl: sender.profileImageUrl,
          requestId: event.request_id,
        })
      } else if (parsed.type === 'message_delete') {
        // Log for now — Convex schema doesn't support message deletion yet
        console.log(`[TwitterSync] message_delete event: ${parsed.data.messages.map((m) => m.message_id).join(', ')}`)
      } else if (parsed.type === 'message_edit') {
        // Log for now — Convex schema doesn't support message edits yet
        console.log(`[TwitterSync] message_edit event: ${parsed.data.message_data.id}`)
      }
    }

    let messagesSynced = 0
    if (messages.length > 0) {
      const messageResult = await withAuthRetry(
        () =>
          this.convexClient.mutation(api.sync.syncTwitterMessages, {
            messages,
            twitterUserId: userId || undefined,
          }),
        createAuthRetryOptions(this.convexClient)
      )
      messagesSynced = messageResult.newMessages ?? 0
    }

    return { conversationsSynced, messagesSynced, contactsSynced: 0 }
  }

  private transformConversation(
    conversation: TwitterConversation,
    users: Record<string, TwitterUser>
  ): {
    conversationId: string
    conversationType: 'dm' | 'group'
    name?: string
    avatarImageUrl?: string
    sortTimestamp?: number
    participants: Array<{
      userId: string
      screenName: string
      name: string
      profileImageUrl?: string
      isAdmin: boolean
      lastReadEventId?: string
    }>
  } {
    return {
      conversationId: conversation.conversation_id,
      conversationType: conversation.type === 'GROUP_DM' ? 'group' : 'dm',
      name: conversation.name || undefined,
      avatarImageUrl: conversation.avatar_image_https || undefined,
      sortTimestamp: conversation.sort_timestamp ? Number.parseInt(conversation.sort_timestamp, 10) : undefined,
      participants: (conversation.participants ?? []).map((participant) => {
        const user = users[participant.user_id]
        return {
          userId: participant.user_id,
          screenName: user?.screen_name ?? participant.user_id,
          name: user?.name ?? user?.screen_name ?? participant.user_id,
          profileImageUrl: user?.profile_image_url_https,
          isAdmin: participant.is_admin ?? false,
          lastReadEventId: participant.last_read_event_id,
        }
      }),
    }
  }

  private resolveSender(
    senderId: string,
    users?: Record<string, TwitterUser>
  ): { screenName?: string; name?: string; profileImageUrl?: string } {
    const user = users?.[senderId]
    return user
      ? { screenName: user.screen_name, name: user.name, profileImageUrl: user.profile_image_url_https }
      : { screenName: senderId, name: senderId }
  }

  private accumulateSyncResult(result: SyncInboxResult): void {
    this.updateProgress({
      totalConversationsSynced: this.progress.totalConversationsSynced + result.conversationsSynced,
      totalMessagesSynced: this.progress.totalMessagesSynced + result.messagesSynced,
      totalContactsSynced: this.progress.totalContactsSynced + result.contactsSynced,
    })
  }

  private updateProgress(update: Partial<TwitterSyncProgress>): void {
    this.progress = { ...this.progress, ...update }
    this.options.onProgress?.(this.progress)
  }
}

/** Extract top-level keys from first entry for debug logging. */
function firstEntryKeys(entries: Record<string, unknown>[]): string {
  const first = entries[0]
  return first ? JSON.stringify(Object.keys(first)) : '[]'
}

let twitterSyncManager: TwitterSyncManager | null = null

export function getTwitterSyncManager(options?: TwitterSyncManagerOptions): TwitterSyncManager {
  if (!twitterSyncManager) {
    twitterSyncManager = new TwitterSyncManager(options)
  }
  return twitterSyncManager
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const TWITTER_EPOCH = 1288834974657

/** Convert a Twitter Snowflake ID to Unix milliseconds. Returns 0 on invalid input. */
function parseSnowflakeMs(id: string): number {
  try {
    const snowflake = BigInt(id)
    return Number(snowflake >> 22n) + TWITTER_EPOCH
  } catch {
    return 0
  }
}
