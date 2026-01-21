/**
 * Unit tests for SlackClient
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockedFunction } from 'vitest'
import { SlackClient } from '../client'
import { SlackAuthError, SlackRequestError, SlackRateLimitError } from '../request'
import type { SlackCredentials } from '../types'

// Mock fetch globally
const mockFetch = vi.fn() as MockedFunction<typeof fetch>
vi.stubGlobal('fetch', mockFetch)

// Mock WebSocket
class MockWebSocket {
  static OPEN = 1
  static CLOSED = 3

  readyState = MockWebSocket.OPEN
  onopen: (() => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: ((error: Error) => void) | null = null

  constructor(_url: string) {
    // Simulate connection after a tick
    setTimeout(() => {
      this.onopen?.()
    }, 0)
  }

  send = vi.fn()
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code: 1000, reason: 'Normal closure' })
  })
}

vi.stubGlobal('WebSocket', MockWebSocket)

// Test credentials
const testCredentials: SlackCredentials = {
  token: 'xoxc-test-token-12345',
  cookie: 'd-test-cookie-value',
}

// Helper to create mock responses
function mockJsonResponse<T>(data: T, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(),
    text: () => Promise.resolve(JSON.stringify(data)),
    json: () => Promise.resolve(data),
  } as Response
}

describe('SlackClient', () => {
  let client: SlackClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = new SlackClient(testCredentials)
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  // ============================================================================
  // Authentication Tests
  // ============================================================================

  describe('isAuthenticated', () => {
    it('returns true when both token and cookie are present', () => {
      expect(client.isAuthenticated).toBe(true)
    })

    it('returns false when token is empty', () => {
      const emptyClient = new SlackClient({ token: '', cookie: 'abc' })
      expect(emptyClient.isAuthenticated).toBe(false)
    })

    it('returns false when cookie is empty', () => {
      const emptyClient = new SlackClient({ token: 'abc', cookie: '' })
      expect(emptyClient.isAuthenticated).toBe(false)
    })
  })

  describe('testAuth', () => {
    it('successfully validates credentials and stores user info', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          ok: true,
          user_id: 'U12345',
          team_id: 'T12345',
          team: 'Test Team',
          user: 'testuser',
        })
      )

      const result = await client.testAuth()

      expect(result.ok).toBe(true)
      expect(result.user_id).toBe('U12345')
      expect(result.team_id).toBe('T12345')
      expect(client.currentUserId).toBe('U12345')
      expect(client.currentTeamId).toBe('T12345')
      expect(client.currentTeamName).toBe('Test Team')
    })

    it('handles auth failure', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          ok: false,
          error: 'invalid_auth',
        })
      )

      await expect(client.testAuth()).rejects.toThrow(SlackAuthError)
    })

    it('handles token expiry error', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          ok: false,
          error: 'token_expired',
        })
      )

      await expect(client.testAuth()).rejects.toThrow(SlackAuthError)
    })
  })

  // ============================================================================
  // User API Tests
  // ============================================================================

  describe('getUserInfo', () => {
    it('fetches user information by ID', async () => {
      const mockUser = {
        id: 'U12345',
        name: 'testuser',
        real_name: 'Test User',
        profile: {
          email: 'test@example.com',
          display_name: 'Test',
        },
      }

      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          ok: true,
          user: mockUser,
        })
      )

      const user = await client.getUserInfo('U12345')

      expect(user).toEqual(mockUser)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('users.info'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('user=U12345'),
        })
      )
    })

    it('returns null when user not found', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          ok: true,
          user: undefined,
        })
      )

      const user = await client.getUserInfo('U99999')
      expect(user).toBeNull()
    })
  })

  // ============================================================================
  // Conversations API Tests
  // ============================================================================

  describe('listConversations', () => {
    it('fetches conversations with default options', async () => {
      const mockConversations = [
        { id: 'C123', name: 'general', is_channel: true },
        { id: 'D456', name: '', is_im: true, user: 'U789' },
      ]

      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          ok: true,
          channels: mockConversations,
          response_metadata: { next_cursor: 'cursor123' },
        })
      )

      const result = await client.listConversations()

      expect(result.conversations).toEqual(mockConversations)
      expect(result.nextCursor).toBe('cursor123')
    })

    it('passes pagination cursor', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          ok: true,
          channels: [],
        })
      )

      await client.listConversations({ cursor: 'next-page' })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('cursor=next-page'),
        })
      )
    })

    it('filters by conversation type', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          ok: true,
          channels: [],
        })
      )

      await client.listConversations({ types: 'im,mpim' })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('types=im%2Cmpim'),
        })
      )
    })
  })

  describe('getHistory', () => {
    it('fetches channel message history', async () => {
      const mockMessages = [
        { type: 'message', user: 'U123', text: 'Hello', ts: '1234567890.000001' },
        { type: 'message', user: 'U456', text: 'Hi!', ts: '1234567890.000002' },
      ]

      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          ok: true,
          messages: mockMessages,
          has_more: true,
          response_metadata: { next_cursor: 'history-cursor' },
        })
      )

      const result = await client.getHistory('C123')

      expect(result.messages).toEqual(mockMessages)
      expect(result.hasMore).toBe(true)
      expect(result.nextCursor).toBe('history-cursor')
    })

    it('passes time range parameters', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          ok: true,
          messages: [],
          has_more: false,
        })
      )

      await client.getHistory('C123', {
        oldest: '1234567890.000000',
        latest: '1234567899.000000',
      })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringMatching(/oldest=1234567890/),
        })
      )
    })
  })

  describe('getReplies', () => {
    it('fetches thread replies', async () => {
      const mockReplies = [
        { type: 'message', user: 'U123', text: 'Parent', ts: '1234567890.000001', thread_ts: '1234567890.000001' },
        { type: 'message', user: 'U456', text: 'Reply', ts: '1234567890.000002', thread_ts: '1234567890.000001' },
      ]

      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          ok: true,
          messages: mockReplies,
          has_more: false,
        })
      )

      const result = await client.getReplies('C123', '1234567890.000001')

      expect(result.messages).toEqual(mockReplies)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('conversations.replies'),
        expect.objectContaining({
          body: expect.stringContaining('ts=1234567890.000001'),
        })
      )
    })
  })

  // ============================================================================
  // Message Sending Tests
  // ============================================================================

  describe('postMessage', () => {
    it('sends a message to a channel', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          ok: true,
          channel: 'C123',
          ts: '1234567890.000001',
          message: {
            type: 'message',
            text: 'Hello world',
            user: 'U123',
            ts: '1234567890.000001',
          },
        })
      )

      const result = await client.postMessage('C123', 'Hello world')

      expect(result.ok).toBe(true)
      expect(result.channel).toBe('C123')
      expect(result.ts).toBe('1234567890.000001')
    })

    it('sends a threaded reply', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          ok: true,
          channel: 'C123',
          ts: '1234567890.000002',
        })
      )

      await client.postMessage('C123', 'Reply text', {
        threadTs: '1234567890.000001',
      })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('thread_ts=1234567890.000001'),
        })
      )
    })

    it('handles channel_not_found error', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          ok: false,
          error: 'channel_not_found',
        })
      )

      await expect(client.postMessage('C999', 'test')).rejects.toThrow(SlackRequestError)
    })
  })

  // ============================================================================
  // Error Handling Tests
  // ============================================================================

  describe('error handling', () => {
    it('throws SlackAuthError for invalid_auth', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          ok: false,
          error: 'invalid_auth',
        })
      )

      await expect(client.testAuth()).rejects.toThrow(SlackAuthError)
    })

    it('throws SlackAuthError for token_expired', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          ok: false,
          error: 'token_expired',
        })
      )

      await expect(client.testAuth()).rejects.toThrow(SlackAuthError)
    })

    it('throws SlackAuthError for not_authed', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          ok: false,
          error: 'not_authed',
        })
      )

      await expect(client.testAuth()).rejects.toThrow(SlackAuthError)
    })

    it('handles rate limit (429) responses', async () => {
      // Mock all retries to return 429 - need 4 total (initial + 3 retries)
      for (let i = 0; i < 4; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: new Headers({ 'Retry-After': '1' }),
          text: () => Promise.resolve(''),
        } as Response)
      }

      // With maxRetries exceeded, it should throw
      await expect(client.testAuth()).rejects.toThrow(SlackRateLimitError)
    }, 15000)

    it('handles server errors (5xx)', async () => {
      // Mock all retries to return 500 - need 4 total (initial + 3 retries)
      for (let i = 0; i < 4; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          headers: new Headers(),
          text: () => Promise.resolve(''),
        } as Response)
      }

      await expect(client.testAuth()).rejects.toThrow(SlackRequestError)
    }, 15000)
  })

})
