/**
 * Integration tests for LinkedInSyncManager
 * Tests the full sync flow including conversations, messages, pagination, and error handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock environment variables before importing linkedin-sync
vi.mock('@cued/env/electron', () => ({
  electronEnv: {
    CONVEX_URL: 'https://test.convex.cloud',
    WORKOS_CLIENT_ID: 'client_test',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  },
}))

// Mock electron module for safeStorage
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn().mockReturnValue(false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/test-app-data'),
  },
}))

// Mock @cued/shared for normalizeConversationURN
vi.mock('@cued/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cued/shared')>()
  return {
    ...original,
    // Normalize fsd_conversation to fs_conversation (matches real implementation)
    normalizeConversationURN: vi.fn((urn: string) =>
      urn.replace('fsd_conversation', 'fs_conversation')
    ),
  }
})

import { LinkedInSyncManager } from '../sync'
import type { LinkedInClient, ConversationsResult, MessagesResult } from '../api/client'
import type { Conversation, Message, MessagingParticipant, PagingMetadata } from '../api/types'
import { LinkedInAuthError } from '../api/request'

// Mock the Convex client
vi.mock('convex/browser', () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    mutation: vi.fn().mockResolvedValue(undefined),
  })),
}))

// Mock @cued/convex api
vi.mock('@cued/convex', () => ({
  api: {
    sync: {
      syncLinkedInMessages: 'sync:syncLinkedInMessages',
      syncLinkedInConversations: 'sync:syncLinkedInConversations',
    },
    syncCursors: {
      getCursor: 'syncCursors:getCursor',
      saveCursor: 'syncCursors:saveCursor',
      clearCursor: 'syncCursors:clearCursor',
    },
  },
}))

// Mock the cursor module to bypass auth checks
vi.mock('../../../sync/cursor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../sync/cursor')>()
  return {
    ...original,
    setConvexAuth: vi.fn().mockResolvedValue('mock-access-token'),
    loadCursor: vi.fn().mockResolvedValue(null),
    saveCursor: vi.fn().mockResolvedValue(undefined),
    clearCursor: vi.fn().mockResolvedValue(undefined),
  }
})

// Mock the messages module to avoid importing actual API calls
vi.mock('../api/messages', () => ({
  getMessages: vi.fn(),
  getMessagesBefore: vi.fn(),
}))

import { getMessages, getMessagesBefore } from '../api/messages'

// ============================================================================
// Test Helpers
// ============================================================================

function createMockParticipant(id: string, firstName: string, lastName: string): MessagingParticipant {
  return {
    entityURN: `urn:li:fsd_profile:${id}`,
    participantType: {
      member: {
        profileUrl: `https://linkedin.com/in/${id}`,
        firstName,
        lastName,
        headline: 'Test Headline',
      },
    },
  }
}

function createMockConversation(
  id: string,
  participantIds: string[],
  lastActivityAt: number = Date.now()
): Conversation {
  return {
    entityURN: `urn:li:fsd_conversation:${id}`,
    title: `Conversation ${id}`,
    lastActivityAt,
    lastReadAt: lastActivityAt - 1000,
    groupChat: participantIds.length > 2,
    read: true,
    categories: ['INMAIL'],
    conversationParticipants: participantIds.map((pid, idx) =>
      createMockParticipant(pid, `User${idx}`, `Last${idx}`)
    ),
    unreadCount: 0,
  }
}

function createMockMessage(
  id: string,
  conversationId: string,
  senderParticipant: MessagingParticipant,
  text: string,
  deliveredAt: number = Date.now()
): Message {
  return {
    entityURN: `urn:li:fsd_message:${id}`,
    conversationURN: `urn:li:fsd_conversation:${conversationId}`,
    body: { text, attributes: [] },
    deliveredAt,
    sender: senderParticipant,
    messageBodyRenderFormat: 'DEFAULT',
    renderContent: [],
    reactionSummaries: [],
  }
}

function createMockLinkedInClient(overrides: Partial<LinkedInClient> = {}): LinkedInClient {
  const defaultConversationsResult: ConversationsResult = {
    conversations: [],
    metadata: undefined,
    syncToken: undefined,
  }

  return {
    cookies: [
      { name: 'li_at', value: 'mock-auth-token' },
      { name: 'JSESSIONID', value: '"ajax:mock-session"' },
    ],
    userEntityURN: 'urn:li:fsd_profile:user123',
    userAgent: 'Mozilla/5.0',
    xLiTrack: '{}',
    eventHandlers: {},
    setCookies: vi.fn(),
    getCookie: vi.fn(),
    getCookieValue: vi.fn(),
    isAuthenticated: vi.fn().mockReturnValue(true),
    getSessionId: vi.fn().mockReturnValue('ajax:mock-session'),
    setEventHandlers: vi.fn(),
    getConversations: vi.fn().mockResolvedValue(defaultConversationsResult),
    getConversationsBefore: vi.fn().mockResolvedValue(defaultConversationsResult),
    getMessages: vi.fn().mockResolvedValue({ messages: [], metadata: undefined }),
    getMessagesBefore: vi.fn().mockResolvedValue({ messages: [], metadata: undefined }),
    sendMessage: vi.fn(),
    getConnections: vi.fn(),
    searchPeople: vi.fn(),
    stopRealtime: vi.fn(),
    ...overrides,
  } as unknown as LinkedInClient
}

// ============================================================================
// Tests
// ============================================================================

describe('LinkedInSyncManager', () => {
  let syncManager: LinkedInSyncManager
  let mockClient: LinkedInClient
  let onProgressMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()

    onProgressMock = vi.fn()

    syncManager = new LinkedInSyncManager({
      onProgress: onProgressMock,
    })

    mockClient = createMockLinkedInClient()
  })

  afterEach(() => {
    syncManager.stop()
    vi.useRealTimers()
  })

  describe('initialization', () => {
    it('initializes with idle status', () => {
      const progress = syncManager.getProgress()
      expect(progress.status).toBe('idle')
      expect(progress.totalConversationsSynced).toBe(0)
      expect(progress.totalMessagesSynced).toBe(0)
    })

    it('setClient stores the client', () => {
      syncManager.setClient(mockClient)
      expect(syncManager.client).toBe(mockClient)
    })
  })

  describe('syncConversations', () => {
    it('fetches conversations and stores sync token', async () => {
      const mockConversations = [
        createMockConversation('conv1', ['user1', 'user2']),
        createMockConversation('conv2', ['user1', 'user3']),
      ]

      const mockResult: ConversationsResult = {
        conversations: mockConversations,
        syncToken: 'new-sync-token-123',
        metadata: { start: 0, count: 2, total: 2 },
      }

      mockClient = createMockLinkedInClient({
        getConversations: vi.fn().mockResolvedValue(mockResult),
      })
      syncManager.setClient(mockClient)

      // Mock getMessages to return empty
      vi.mocked(getMessages).mockResolvedValue({ messages: [], metadata: undefined })

      await syncManager.syncConversations()

      expect(mockClient.getConversations).toHaveBeenCalledWith(undefined)

      // Verify progress was updated
      expect(onProgressMock).toHaveBeenCalled()
    })

    it('uses sync token for pagination during full sync', async () => {
      // Create 50 conversations (MAX_CONVERSATIONS_PER_SYNC) so full sync continues
      const manyConversations = Array.from({ length: 50 }, (_, i) =>
        createMockConversation(`conv${i}`, ['user1', `user${i + 10}`])
      )

      const mockResult: ConversationsResult = {
        conversations: manyConversations,
        syncToken: 'first-sync-token',
        metadata: undefined,
      }

      const mockResultSecond: ConversationsResult = {
        conversations: [createMockConversation('conv99', ['user1', 'user99'])],
        syncToken: 'second-sync-token',
        metadata: undefined,
      }

      const getConversationsMock = vi.fn()
        .mockResolvedValueOnce(mockResult)
        .mockResolvedValueOnce(mockResultSecond)

      mockClient = createMockLinkedInClient({
        getConversations: getConversationsMock,
      })
      syncManager.setClient(mockClient)
      vi.mocked(getMessages).mockResolvedValue({ messages: [], metadata: undefined })

      // First sync - returns max conversations, so full sync continues
      await syncManager.syncConversations()
      expect(getConversationsMock).toHaveBeenCalledWith(undefined)

      // Second sync should use stored sync token (pagination within full sync)
      await syncManager.syncConversations()
      expect(getConversationsMock).toHaveBeenCalledWith('first-sync-token')
    })

    it('syncs messages for each conversation', async () => {
      const mockConversations = [
        createMockConversation('conv1', ['user1', 'user2']),
        createMockConversation('conv2', ['user1', 'user3']),
      ]

      mockClient = createMockLinkedInClient({
        getConversations: vi.fn().mockResolvedValue({
          conversations: mockConversations,
          syncToken: 'sync-token',
          metadata: undefined,
        }),
      })
      syncManager.setClient(mockClient)

      const participant = createMockParticipant('user1', 'Test', 'User')
      vi.mocked(getMessages)
        .mockResolvedValueOnce({
          messages: [createMockMessage('msg1', 'conv1', participant, 'Hello')],
          metadata: { start: 0, count: 1, total: 1 },
        })
        .mockResolvedValueOnce({
          messages: [createMockMessage('msg2', 'conv2', participant, 'Hi there')],
          metadata: { start: 0, count: 1, total: 1 },
        })

      await syncManager.syncConversations()

      // getMessages should be called for each conversation (URN normalized to fs_conversation)
      expect(getMessages).toHaveBeenCalledTimes(2)
      expect(getMessages).toHaveBeenCalledWith(
        mockClient,
        'urn:li:fs_conversation:conv1',
        undefined
      )
      expect(getMessages).toHaveBeenCalledWith(
        mockClient,
        'urn:li:fs_conversation:conv2',
        undefined
      )
    })
  })

  describe('syncMessages', () => {
    it('fetches messages for a conversation', async () => {
      const participant = createMockParticipant('user1', 'Test', 'User')
      const mockMessages = [
        createMockMessage('msg1', 'conv1', participant, 'Hello'),
        createMockMessage('msg2', 'conv1', participant, 'How are you?'),
      ]

      vi.mocked(getMessages).mockResolvedValue({
        messages: mockMessages,
        metadata: { start: 0, count: 2, total: 2 },
      })

      syncManager.setClient(mockClient)
      await syncManager.syncMessages('urn:li:fsd_conversation:conv1')

      // API calls use original URN format (LinkedIn expects their format)
      expect(getMessages).toHaveBeenCalledWith(
        mockClient,
        'urn:li:fsd_conversation:conv1',
        undefined
      )

      const progress = syncManager.getProgress()
      expect(progress.totalMessagesSynced).toBe(2)
    })

    it('paginates using timestamps via getMessagesBefore when first batch is full', async () => {
      const participant = createMockParticipant('user1', 'Test', 'User')

      // Create 20 messages (full page) with decreasing timestamps
      const firstBatch = Array.from({ length: 20 }, (_, i) =>
        createMockMessage(`msg${i}`, 'conv1', participant, `Message ${i}`, 1000 - i)
      )
      // Second batch has 5 messages (partial page = end of history)
      const secondBatch = Array.from({ length: 5 }, (_, i) =>
        createMockMessage(`msg${i + 20}`, 'conv1', participant, `Message ${i + 20}`, 980 - i - 1)
      )

      vi.mocked(getMessages).mockResolvedValueOnce({
        messages: firstBatch,
        metadata: { start: 0, count: 20, total: 25 },
      })
      vi.mocked(getMessagesBefore).mockResolvedValueOnce({
        messages: secondBatch,
        metadata: { start: 20, count: 5, total: 25 },
      })

      syncManager.setClient(mockClient)
      await syncManager.syncMessages('urn:li:fsd_conversation:conv1')

      // Should call getMessagesBefore with oldest timestamp from first batch (981)
      // API calls use original URN format (LinkedIn expects their format)
      expect(getMessagesBefore).toHaveBeenCalledWith(
        mockClient,
        'urn:li:fsd_conversation:conv1',
        981 // 1000 - 19 = oldest message timestamp
      )

      // Total synced should be 25
      const progress = syncManager.getProgress()
      expect(progress.totalMessagesSynced).toBe(25)
    })

    it('does not paginate when first batch is partial (less than PAGE_SIZE)', async () => {
      const participant = createMockParticipant('user1', 'Test', 'User')

      // Only 5 messages (partial page = no need to paginate)
      const messages = Array.from({ length: 5 }, (_, i) =>
        createMockMessage(`msg${i}`, 'conv1', participant, `Message ${i}`, 1000 - i)
      )

      vi.mocked(getMessages).mockResolvedValueOnce({
        messages,
        metadata: { start: 0, count: 5, total: 5 },
      })

      syncManager.setClient(mockClient)
      await syncManager.syncMessages('urn:li:fsd_conversation:conv1')

      // Should NOT call getMessagesBefore since first batch was partial
      expect(getMessagesBefore).not.toHaveBeenCalled()

      const progress = syncManager.getProgress()
      expect(progress.totalMessagesSynced).toBe(5)
    })

    it('updates progress with current conversation info', async () => {
      const participant = createMockParticipant('user1', 'Test', 'User')
      vi.mocked(getMessages).mockResolvedValue({
        messages: [createMockMessage('msg1', 'conv1', participant, 'Hello')],
        metadata: { start: 0, count: 1, total: 1 },
      })

      syncManager.setClient(mockClient)
      await syncManager.syncMessages('urn:li:fsd_conversation:conv1')

      // Find the progress update that includes currentConversation
      const progressCalls = onProgressMock.mock.calls
      const lastProgressWithConv = progressCalls.find(
        (call) => call[0].currentConversation?.messagesInConversation === 1
      )

      expect(lastProgressWithConv).toBeDefined()
      // URN is normalized to fs_conversation format
      expect(lastProgressWithConv![0].currentConversation.conversationId).toBe(
        'urn:li:fs_conversation:conv1'
      )
    })

    it('handles empty messages gracefully', async () => {
      vi.mocked(getMessages).mockResolvedValue({
        messages: [],
        metadata: undefined,
      })

      syncManager.setClient(mockClient)
      await syncManager.syncMessages('urn:li:fsd_conversation:conv1')

      const progress = syncManager.getProgress()
      expect(progress.totalMessagesSynced).toBe(0)
    })
  })

  describe('pagination: multiple pages of conversations', () => {
    it('handles multiple conversation batches correctly', async () => {
      // First batch needs exactly 50 conversations (MAX_CONVERSATIONS_PER_SYNC)
      // to keep fullSyncState active and preserve sync token for next call
      const batch1Conversations = Array.from({ length: 50 }, (_, i) =>
        createMockConversation(`conv${i}`, ['user1', `user${i + 10}`], Date.now() - i * 1000)
      )

      const batch2Conversations = Array.from({ length: 10 }, (_, i) =>
        createMockConversation(`conv${i + 50}`, ['user1', `user${i + 100}`], Date.now() - (i + 50) * 1000)
      )

      const getConversationsMock = vi.fn()
        .mockResolvedValueOnce({
          conversations: batch1Conversations,
          syncToken: 'token-after-batch1',
          metadata: { start: 0, count: 50, total: 60 },
        })
        .mockResolvedValueOnce({
          conversations: batch2Conversations,
          syncToken: 'token-after-batch2',
          metadata: { start: 50, count: 10, total: 60 },
        })

      mockClient = createMockLinkedInClient({
        getConversations: getConversationsMock,
      })
      syncManager.setClient(mockClient)
      vi.mocked(getMessages).mockResolvedValue({ messages: [], metadata: undefined })

      // First batch - returns max conversations, so full sync continues
      await syncManager.syncConversations()
      expect(getConversationsMock).toHaveBeenCalledWith(undefined)
      expect(syncManager.getProgress().totalConversationsSynced).toBe(50)

      // Second batch uses sync token (pagination within full sync)
      await syncManager.syncConversations()
      expect(getConversationsMock).toHaveBeenCalledWith('token-after-batch1')
      expect(syncManager.getProgress().totalConversationsSynced).toBe(60)
    })

    it('respects MAX_CONVERSATIONS_PER_SYNC limit', async () => {
      // Create more conversations than the limit (50)
      const manyConversations = Array.from({ length: 60 }, (_, i) =>
        createMockConversation(`conv${i}`, ['user1', `user${i + 100}`])
      )

      mockClient = createMockLinkedInClient({
        getConversations: vi.fn().mockResolvedValue({
          conversations: manyConversations,
          syncToken: 'sync-token',
          metadata: undefined,
        }),
      })
      syncManager.setClient(mockClient)
      vi.mocked(getMessages).mockResolvedValue({ messages: [], metadata: undefined })

      await syncManager.syncConversations()

      // Should only process 50 conversations (MAX_CONVERSATIONS_PER_SYNC)
      expect(getMessages).toHaveBeenCalledTimes(50)
    })
  })

  describe('error handling: auth errors set error status', () => {
    it('sets error status when auth error occurs', async () => {
      mockClient = createMockLinkedInClient({
        getConversations: vi.fn().mockRejectedValue(
          new LinkedInAuthError('Authentication failed', 401)
        ),
      })
      syncManager.setClient(mockClient)

      await syncManager.runSync()

      expect(syncManager.getProgress().status).toBe('error')
      expect(syncManager.getProgress().error).toContain('Authentication failed')
    })

    it('sets error status on 401 error', async () => {
      mockClient = createMockLinkedInClient({
        getConversations: vi.fn().mockRejectedValue(new Error('Request failed: 401 Unauthorized')),
      })
      syncManager.setClient(mockClient)

      await syncManager.runSync()

      expect(syncManager.getProgress().status).toBe('error')
    })

    it('sets error status on 403 error', async () => {
      mockClient = createMockLinkedInClient({
        getConversations: vi.fn().mockRejectedValue(new Error('Request failed: 403 Forbidden')),
      })
      syncManager.setClient(mockClient)

      await syncManager.runSync()

      expect(syncManager.getProgress().status).toBe('error')
    })

    it('sets error status on unauthenticated error', async () => {
      mockClient = createMockLinkedInClient({
        getConversations: vi.fn().mockRejectedValue(new Error('User is unauthenticated')),
      })
      syncManager.setClient(mockClient)

      await syncManager.runSync()

      expect(syncManager.getProgress().status).toBe('error')
    })

    it('sets error status for non-auth errors', async () => {
      mockClient = createMockLinkedInClient({
        getConversations: vi.fn().mockRejectedValue(new Error('Network timeout')),
      })
      syncManager.setClient(mockClient)

      await syncManager.runSync()

      expect(syncManager.getProgress().status).toBe('error')
    })

    it('sets error status and message on sync failure', async () => {
      mockClient = createMockLinkedInClient({
        getConversations: vi.fn().mockRejectedValue(new Error('Something went wrong')),
      })
      syncManager.setClient(mockClient)

      await syncManager.runSync()

      const progress = syncManager.getProgress()
      expect(progress.status).toBe('error')
      expect(progress.error).toBe('Something went wrong')
    })
  })

  describe('runSync', () => {
    it('prevents concurrent syncs', async () => {
      let resolveFirst: () => void
      const slowPromise = new Promise<ConversationsResult>((resolve) => {
        resolveFirst = () =>
          resolve({ conversations: [], syncToken: undefined, metadata: undefined })
      })

      mockClient = createMockLinkedInClient({
        getConversations: vi.fn().mockReturnValue(slowPromise),
      })
      syncManager.setClient(mockClient)

      // Start first sync
      const firstSync = syncManager.runSync()

      // Try to start second sync (should be skipped)
      const secondSync = syncManager.runSync()

      // Resolve the first sync
      resolveFirst!()
      await firstSync
      await secondSync

      // getConversations should only be called once
      expect(mockClient.getConversations).toHaveBeenCalledTimes(1)
    })

    it('sets syncing status during sync', async () => {
      const statusUpdates: string[] = []

      const customProgressMock = vi.fn((progress) => {
        statusUpdates.push(progress.status)
      })

      const managerWithCustomProgress = new LinkedInSyncManager({
        onProgress: customProgressMock,
      })

      mockClient = createMockLinkedInClient({
        getConversations: vi.fn().mockResolvedValue({
          conversations: [],
          syncToken: undefined,
          metadata: undefined,
        }),
      })
      managerWithCustomProgress.setClient(mockClient)

      await managerWithCustomProgress.runSync()

      expect(statusUpdates).toContain('syncing')
      expect(statusUpdates[statusUpdates.length - 1]).toBe('idle')

      managerWithCustomProgress.stop()
    })

    it('updates lastSyncAt on successful sync', async () => {
      mockClient = createMockLinkedInClient({
        getConversations: vi.fn().mockResolvedValue({
          conversations: [],
          syncToken: undefined,
          metadata: undefined,
        }),
      })
      syncManager.setClient(mockClient)

      const beforeSync = Date.now()
      await syncManager.runSync()
      const afterSync = Date.now()

      const progress = syncManager.getProgress()
      expect(progress.lastSyncAt).toBeGreaterThanOrEqual(beforeSync)
      expect(progress.lastSyncAt).toBeLessThanOrEqual(afterSync)
    })

    it('returns early if no client is set', async () => {
      // Don't set a client
      await syncManager.runSync()

      expect(syncManager.getProgress().status).toBe('error')
      expect(syncManager.getProgress().error).toBe('LinkedIn client not configured')
    })
  })

  describe('lifecycle: start and stop', () => {
    it('start() begins sync interval', async () => {
      mockClient = createMockLinkedInClient({
        getConversations: vi.fn().mockResolvedValue({
          conversations: [],
          syncToken: undefined,
          metadata: undefined,
        }),
      })
      syncManager.setClient(mockClient)

      syncManager.start()

      // Wait for the initial sync (runs immediately via runSync())
      // Use advanceTimersByTimeAsync with a small amount to flush promises
      await vi.advanceTimersByTimeAsync(10)
      const initialCalls = vi.mocked(mockClient.getConversations).mock.calls.length
      expect(initialCalls).toBeGreaterThanOrEqual(1)

      // Advance by 5 minutes (sync interval) to trigger another sync
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
      expect(mockClient.getConversations).toHaveBeenCalledTimes(initialCalls + 1)
    })

    it('stop() clears sync interval', async () => {
      mockClient = createMockLinkedInClient({
        getConversations: vi.fn().mockResolvedValue({
          conversations: [],
          syncToken: undefined,
          metadata: undefined,
        }),
      })
      syncManager.setClient(mockClient)

      syncManager.start()
      // Wait for initial sync
      await vi.advanceTimersByTimeAsync(10)
      const callsAfterStart = vi.mocked(mockClient.getConversations).mock.calls.length
      expect(callsAfterStart).toBeGreaterThanOrEqual(1)

      syncManager.stop()

      // Advance by 5 minutes
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
      // Should be same call count (no additional calls after stop)
      expect(mockClient.getConversations).toHaveBeenCalledTimes(callsAfterStart)
    })

    it('start() does nothing if already running', () => {
      syncManager.setClient(mockClient)
      syncManager.start()
      syncManager.start() // Second call should do nothing

      // Only one interval should be set (verified by stop working correctly)
      syncManager.stop()
    })
  })

  describe('reset', () => {
    it('clears all sync state', async () => {
      // Setup some state
      mockClient = createMockLinkedInClient({
        getConversations: vi.fn().mockResolvedValue({
          conversations: [createMockConversation('conv1', ['user1', 'user2'])],
          syncToken: 'test-token',
          metadata: undefined,
        }),
      })
      syncManager.setClient(mockClient)

      const participant = createMockParticipant('user1', 'Test', 'User')
      vi.mocked(getMessages).mockResolvedValue({
        messages: [createMockMessage('msg1', 'conv1', participant, 'Hello')],
        metadata: { start: 0, count: 1, total: 1 },
      })

      await syncManager.runSync()
      expect(syncManager.getProgress().totalConversationsSynced).toBe(1)

      // Reset
      syncManager.reset()

      const progress = syncManager.getProgress()
      expect(progress.status).toBe('idle')
      expect(progress.totalConversationsSynced).toBe(0)
      expect(progress.totalMessagesSynced).toBe(0)
    })
  })

  describe('callback setters', () => {
    it('setProgressCallback updates the progress callback', async () => {
      const newProgressCallback = vi.fn()
      syncManager.setProgressCallback(newProgressCallback)

      mockClient = createMockLinkedInClient({
        getConversations: vi.fn().mockResolvedValue({
          conversations: [],
          syncToken: undefined,
          metadata: undefined,
        }),
      })
      syncManager.setClient(mockClient)

      await syncManager.runSync()

      expect(newProgressCallback).toHaveBeenCalled()
    })
  })
})
