import { useCallback, useEffect, useState } from 'react'
import type { ActionResponse } from '@/api/actions'
import { fetchActions, swipeAction } from '@/api/actions'
import type { SwipeDirection } from '@/data/types'

// Check if mock mode is enabled via environment variable
const USE_MOCK_DATA = import.meta.env.VITE_USE_MOCK_DATA === 'true'

// Helper to create mock message response with required fields
function mockMessage(
  id: number,
  text: string,
  date: number,
  senderName: string | null,
  isFromMe = false
) {
  return {
    id,
    text,
    date,
    is_from_me: isFromMe,
    is_read: true,
    date_read: isFromMe ? date : null,
    sender_name: senderName,
    is_sent: true,
    is_delivered: true,
    date_delivered: isFromMe ? date : null,
    error: 0,
    attachments: []
  }
}

// Mock data for development when backend is unavailable (only used when USE_MOCK_DATA=true)
const MOCK_ACTIONS: ActionResponse[] = [
  {
    id: 1,
    type: 'respond_to_message',
    status: 'pending',
    priority: 90,
    chat_id: 1,
    person_id: 1,
    message_id: 100,
    payload: null,
    created_at: Date.now() - 3600000,
    remind_at: null,
    snoozed_until: null,
    completed_at: null,
    discarded_at: null,
    chat_name: 'Alex Chen',
    person_name: 'Alex Chen',
    message_text:
      'Hey! Did you get a chance to look at that proposal I sent over yesterday? Would love your thoughts on the pricing section.',
    message_timestamp: Date.now() - 3600000,
    recent_messages: [
      mockMessage(99, 'Just sent you the proposal doc', Date.now() - 7200000, 'Alex Chen'),
      mockMessage(
        100,
        'Hey! Did you get a chance to look at that proposal I sent over yesterday? Would love your thoughts on the pricing section.',
        Date.now() - 3600000,
        'Alex Chen'
      )
    ]
  },
  {
    id: 2,
    type: 'respond_to_message',
    status: 'pending',
    priority: 85,
    chat_id: 2,
    person_id: 2,
    message_id: 200,
    payload: null,
    created_at: Date.now() - 7200000,
    remind_at: null,
    snoozed_until: null,
    completed_at: null,
    discarded_at: null,
    chat_name: 'Sarah Miller',
    person_name: 'Sarah Miller',
    message_text: 'Can we push our meeting to 3pm tomorrow?',
    message_timestamp: Date.now() - 7200000,
    recent_messages: [
      mockMessage(
        200,
        'Can we push our meeting to 3pm tomorrow?',
        Date.now() - 7200000,
        'Sarah Miller'
      )
    ]
  },
  {
    id: 3,
    type: 'eod_contact',
    status: 'pending',
    priority: 75,
    chat_id: 3,
    person_id: 3,
    message_id: null,
    payload: { met_at: 'Tech Conference 2026' },
    created_at: Date.now() - 10800000,
    remind_at: null,
    snoozed_until: null,
    completed_at: null,
    discarded_at: null,
    chat_name: null,
    person_name: 'Jordan Lee',
    message_text: null,
    message_timestamp: null,
    recent_messages: []
  },
  {
    id: 4,
    type: 'respond_to_message',
    status: 'pending',
    priority: 70,
    chat_id: 4,
    person_id: 4,
    message_id: 400,
    payload: null,
    created_at: Date.now() - 14400000,
    remind_at: null,
    snoozed_until: null,
    completed_at: null,
    discarded_at: null,
    chat_name: 'Team Standup',
    person_name: 'Mike Johnson',
    message_text: 'Anyone free for a quick sync?',
    message_timestamp: Date.now() - 14400000,
    recent_messages: [
      mockMessage(400, 'Anyone free for a quick sync?', Date.now() - 14400000, 'Mike Johnson')
    ]
  },
  {
    id: 5,
    type: 'respond_to_message',
    status: 'pending',
    priority: 65,
    chat_id: 5,
    person_id: 5,
    message_id: 500,
    payload: null,
    created_at: Date.now() - 18000000,
    remind_at: null,
    snoozed_until: null,
    completed_at: null,
    discarded_at: null,
    chat_name: 'Emily Davis',
    person_name: 'Emily Davis',
    message_text: 'Thanks for the intro! Looking forward to connecting.',
    message_timestamp: Date.now() - 18000000,
    recent_messages: [
      mockMessage(
        500,
        'Thanks for the intro! Looking forward to connecting.',
        Date.now() - 18000000,
        'Emily Davis'
      )
    ]
  }
]

export function useActions(actionType?: string) {
  const [actions, setActions] = useState<ActionResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadActions = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await fetchActions('pending', 50, actionType)
      // Only use mock data when explicitly enabled and no real data exists
      setActions(USE_MOCK_DATA && data.length === 0 ? MOCK_ACTIONS : data)
    } catch (err) {
      if (USE_MOCK_DATA) {
        // Fallback to mock data when backend is unavailable (dev mode only)
        setActions(MOCK_ACTIONS)
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load actions')
      }
    } finally {
      setLoading(false)
    }
  }, [actionType])

  useEffect(() => {
    loadActions()
  }, [loadActions])

  const handleSwipe = useCallback(
    async (
      actionId: number,
      direction: SwipeDirection,
      responseText?: string,
      snoozeMinutes?: number
    ) => {
      try {
        await swipeAction(actionId, direction, responseText, snoozeMinutes)
        // Remove the swiped action from the list
        setActions((prev) => prev.filter((a) => a.id !== actionId))
      } catch (err) {
        // If backend fails, still remove the action locally (mock mode)
        setActions((prev) => prev.filter((a) => a.id !== actionId))
        // setError(err instanceof Error ? err.message : 'Failed to process swipe')
        console.error('[useActions] Failed to process swipe:', err)
      }
    },
    []
  )

  const currentAction = actions[0] || null
  const remainingCount = actions.length

  return {
    actions,
    currentAction,
    remainingCount,
    loading,
    error,
    handleSwipe,
    refresh: loadActions
  }
}
