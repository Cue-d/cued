import { beforeEach, describe, expect, it, vi } from 'vitest'

// Keep sync tests isolated from real auth/storage/network.
vi.mock('@cued/convex', () => ({
  api: {
    sync: {
      syncSlackConversations: 'sync:syncSlackConversations',
      syncSlackNativeMessages: 'sync:syncSlackNativeMessages',
    },
    integrations: {
      updateSlackStatus: 'integrations:updateSlackStatus',
    },
    syncCursors: {
      getSyncCursor: 'syncCursors:getSyncCursor',
      upsertSyncCursor: 'syncCursors:upsertSyncCursor',
      deleteSyncCursor: 'syncCursors:deleteSyncCursor',
    },
  },
}))

vi.mock('../../../sync/cursor', () => ({
  createConvexClient: vi.fn(() => ({
    setAuth: vi.fn(),
    query: vi.fn().mockResolvedValue(null),
    mutation: vi.fn().mockResolvedValue(undefined),
  })),
  loadCursor: vi.fn().mockResolvedValue(null),
  saveCursor: vi.fn().mockResolvedValue(undefined),
  clearCursor: vi.fn().mockResolvedValue(undefined),
  setConvexAuth: vi.fn().mockResolvedValue('mock-token'),
  createAuthRetryOptions: vi.fn(() => ({
    getValidToken: vi.fn().mockResolvedValue('mock-token'),
    maxRetries: 0,
  })),
}))

vi.mock('../../../auth/auth-utils', () => ({
  isAuthError: vi.fn().mockReturnValue(false),
  withAuthRetry: vi.fn(async (fn: () => Promise<unknown>) => await fn()),
}))

vi.mock('../../../auth/auth-manager', () => ({
  getAuthState: vi.fn(() => ({ user: null })),
}))

vi.mock('../../../sync/debug-logger', () => ({
  getSyncDebugLogger: vi.fn(() => ({
    logSyncStart: vi.fn(),
    logSyncComplete: vi.fn(),
    logSyncError: vi.fn(),
  })),
}))

vi.mock('../auth', () => ({
  getSlackCredentials: vi.fn().mockReturnValue(null),
  getAllSlackCredentials: vi.fn().mockReturnValue([]),
  saveSlackCredentials: vi.fn(),
  deleteSlackCredentials: vi.fn(),
}))

import { SlackSyncManager } from '../sync'
import type { SlackConversation, SlackUser } from '../api'

function createSlackUser(userId: string, displayName: string): SlackUser {
  return {
    id: userId,
    team_id: 'T_TEST',
    name: displayName.toLowerCase(),
    profile: {
      display_name: displayName,
      real_name: displayName,
      image_72: `https://example.com/${userId}.png`,
    },
  }
}

function createDmConversation(id: string, userId: string): SlackConversation {
  return {
    id,
    is_im: true,
    user: userId,
  }
}

describe('SlackSyncManager user hydration', () => {
  let syncManager: SlackSyncManager
  let mockClient: {
    listUsers: ReturnType<typeof vi.fn>
    listConversations: ReturnType<typeof vi.fn>
    getUserInfo: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    vi.clearAllMocks()

    syncManager = new SlackSyncManager()
    mockClient = {
      listUsers: vi.fn(),
      listConversations: vi.fn(),
      getUserInfo: vi.fn(),
    }

    ;(syncManager as any).client = mockClient
    ;(syncManager as any).credentials = {
      token: 'xoxc-test',
      cookie: 'd-test',
      teamId: 'T_TEST',
      teamName: 'Test Workspace',
      userId: 'U_SELF',
      savedAt: Date.now(),
    }

    vi.spyOn(syncManager, 'syncMessages').mockResolvedValue(undefined)
  })

  it('uses users.list warmup to avoid per-DM users.info lookups', async () => {
    mockClient.listUsers.mockResolvedValue({
      users: [createSlackUser('U_ALICE', 'Alice'), createSlackUser('U_BOB', 'Bob')],
      nextCursor: undefined,
    })
    mockClient.listConversations.mockResolvedValue({
      conversations: [
        createDmConversation('D_ALICE', 'U_ALICE'),
        createDmConversation('D_BOB', 'U_BOB'),
      ],
      nextCursor: undefined,
    })

    await syncManager.syncConversations()

    expect(mockClient.listUsers).toHaveBeenCalledTimes(1)
    expect(mockClient.getUserInfo).not.toHaveBeenCalled()
    expect(syncManager.syncMessages).toHaveBeenCalledTimes(2)
  })

  it('falls back to users.info only for DM users missing from users.list', async () => {
    mockClient.listUsers.mockResolvedValue({
      users: [createSlackUser('U_ALICE', 'Alice')],
      nextCursor: undefined,
    })
    mockClient.listConversations.mockResolvedValue({
      conversations: [
        createDmConversation('D_ALICE', 'U_ALICE'),
        createDmConversation('D_CHARLIE', 'U_CHARLIE'),
      ],
      nextCursor: undefined,
    })
    mockClient.getUserInfo.mockResolvedValue(createSlackUser('U_CHARLIE', 'Charlie'))

    await syncManager.syncConversations()

    expect(mockClient.listUsers).toHaveBeenCalledTimes(1)
    expect(mockClient.getUserInfo).toHaveBeenCalledTimes(1)
    expect(mockClient.getUserInfo).toHaveBeenCalledWith('U_CHARLIE')
  })

  it('hydrates user directory only once within cache TTL', async () => {
    mockClient.listUsers.mockResolvedValue({
      users: [createSlackUser('U_ALICE', 'Alice')],
      nextCursor: undefined,
    })
    mockClient.listConversations.mockResolvedValue({
      conversations: [createDmConversation('D_ALICE', 'U_ALICE')],
      nextCursor: undefined,
    })

    await syncManager.syncConversations()
    await syncManager.syncConversations()

    expect(mockClient.listUsers).toHaveBeenCalledTimes(1)
  })

  it('retries without mentionedUsers.avatarUrl when backend validator rejects it', async () => {
    const mutationMock = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'ArgumentValidationError: Object contains extra field `avatarUrl` that is not in the validator. Path: .mentionedUsers[0]'
        )
      )
      .mockResolvedValueOnce(undefined)
    ;(syncManager as any).convexClient.mutation = mutationMock

    mockClient.getUserInfo.mockImplementation(async (userId: string) => {
      if (userId === 'U09MENTION') return createSlackUser('U09MENTION', 'Mention User')
      return createSlackUser('U09SENDER', 'Sender User')
    })

    await (syncManager as any).syncMessagesToConvex('D_TEST', [
      {
        type: 'message',
        ts: '1730000000.000001',
        text: 'hello <@U09MENTION>',
        user: 'U09SENDER',
      },
    ])

    expect(mutationMock).toHaveBeenCalledTimes(2)

    const secondCallArgs = mutationMock.mock.calls[1][1]
    expect(secondCallArgs.mentionedUsers).toHaveLength(1)
    expect('avatarUrl' in secondCallArgs.mentionedUsers[0]).toBe(false)
  })
})
