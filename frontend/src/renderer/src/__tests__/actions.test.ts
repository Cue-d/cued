import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchActions, swipeAction, searchMessages, addContactContext } from '@/api/actions'
import * as client from '@/api/client'

vi.mock('@/api/client', () => ({
  fetchActions: vi.fn(),
  swipeAction: vi.fn(),
  searchMessages: vi.fn(),
  addContactContext: vi.fn()
}))

const mockFetchActions = vi.mocked(client.fetchActions)
const mockSwipeAction = vi.mocked(client.swipeAction)
const mockSearchMessages = vi.mocked(client.searchMessages)
const mockAddContactContext = vi.mocked(client.addContactContext)

describe('actions API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('fetchActions', () => {
    it('calls client with correct parameters', async () => {
      const mockActions = [
        {
          id: 1,
          type: 'respond_to_message' as const,
          status: 'pending' as const,
          priority: 90,
          chat_id: 1,
          person_id: 1,
          message_id: 100,
          payload: null,
          created_at: Date.now(),
          remind_at: null,
          snoozed_until: null,
          completed_at: null,
          discarded_at: null,
          chat_name: 'Test',
          person_name: 'Test',
          message_text: 'Test',
          message_timestamp: Date.now(),
          recent_messages: []
        }
      ]
      mockFetchActions.mockResolvedValue(mockActions)

      const result = await fetchActions('pending', 50)

      expect(mockFetchActions).toHaveBeenCalledWith('pending', 50, undefined)
      expect(result).toEqual(mockActions)
    })

    it('uses default parameters', async () => {
      mockFetchActions.mockResolvedValue([])

      await fetchActions()

      expect(mockFetchActions).toHaveBeenCalledWith('pending', 50, undefined)
    })

    it('passes action type filter', async () => {
      mockFetchActions.mockResolvedValue([])

      await fetchActions('pending', 50, 'respond_to_message')

      expect(mockFetchActions).toHaveBeenCalledWith('pending', 50, 'respond_to_message')
    })
  })

  describe('swipeAction', () => {
    it('passes direction and optional response text', async () => {
      const mockResponse = {
        id: 1,
        type: 'respond_to_message' as const,
        status: 'completed' as const,
        priority: 90,
        chat_id: 1,
        person_id: 1,
        message_id: 100,
        payload: null,
        created_at: Date.now(),
        remind_at: null,
        snoozed_until: null,
        completed_at: Date.now(),
        discarded_at: null,
        chat_name: 'Test',
        person_name: 'Test',
        message_text: 'Test',
        message_timestamp: Date.now(),
        recent_messages: []
      }
      mockSwipeAction.mockResolvedValue(mockResponse)

      const result = await swipeAction(1, 'right', 'Response text')

      expect(mockSwipeAction).toHaveBeenCalledWith(1, {
        direction: 'right',
        response_text: 'Response text',
        snooze_minutes: undefined
      })
      expect(result).toEqual(mockResponse)
    })

    it('passes snooze minutes for up swipe', async () => {
      const mockResponse = {
        id: 1,
        type: 'respond_to_message' as const,
        status: 'snoozed' as const,
        priority: 90,
        chat_id: 1,
        person_id: 1,
        message_id: 100,
        payload: null,
        created_at: Date.now(),
        remind_at: null,
        snoozed_until: Date.now() + 3600000,
        completed_at: null,
        discarded_at: null,
        chat_name: 'Test',
        person_name: 'Test',
        message_text: 'Test',
        message_timestamp: Date.now(),
        recent_messages: []
      }
      mockSwipeAction.mockResolvedValue(mockResponse)

      const result = await swipeAction(1, 'up', undefined, 60)

      expect(mockSwipeAction).toHaveBeenCalledWith(1, {
        direction: 'up',
        response_text: undefined,
        snooze_minutes: 60
      })
      expect(result).toEqual(mockResponse)
    })

    it('handles left swipe without optional parameters', async () => {
      const mockResponse = {
        id: 1,
        type: 'respond_to_message' as const,
        status: 'discarded' as const,
        priority: 90,
        chat_id: 1,
        person_id: 1,
        message_id: 100,
        payload: null,
        created_at: Date.now(),
        remind_at: null,
        snoozed_until: null,
        completed_at: null,
        discarded_at: Date.now(),
        chat_name: 'Test',
        person_name: 'Test',
        message_text: 'Test',
        message_timestamp: Date.now(),
        recent_messages: []
      }
      mockSwipeAction.mockResolvedValue(mockResponse)

      const result = await swipeAction(1, 'left')

      expect(mockSwipeAction).toHaveBeenCalledWith(1, {
        direction: 'left',
        response_text: undefined,
        snooze_minutes: undefined
      })
      expect(result).toEqual(mockResponse)
    })
  })

  describe('searchMessages', () => {
    it('passes query correctly', async () => {
      const mockResults = [
        {
          message_id: 1,
          chat_id: 1,
          text: 'Test message',
          timestamp: Date.now(),
          sender_name: 'Test',
          chat_name: 'Test',
          rank: 0.9
        }
      ]
      mockSearchMessages.mockResolvedValue(mockResults)

      const result = await searchMessages('test query', 50)

      expect(mockSearchMessages).toHaveBeenCalledWith('test query', 50)
      expect(result).toEqual(mockResults)
    })

    it('uses default limit', async () => {
      mockSearchMessages.mockResolvedValue([])

      await searchMessages('test query')

      expect(mockSearchMessages).toHaveBeenCalledWith('test query', 50)
    })
  })

  describe('addContactContext', () => {
    it('passes personId and notes', async () => {
      mockAddContactContext.mockResolvedValue({ success: true })

      const result = await addContactContext(123, 'Met at conference')

      expect(mockAddContactContext).toHaveBeenCalledWith(123, 'Met at conference')
      expect(result).toEqual({ success: true })
    })

    it('handles empty notes', async () => {
      mockAddContactContext.mockResolvedValue({ success: true })

      await addContactContext(123, '')

      expect(mockAddContactContext).toHaveBeenCalledWith(123, '')
    })
  })
})
