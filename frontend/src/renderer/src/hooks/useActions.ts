import { useCallback, useEffect, useState, useRef } from 'react'
import type { ActionResponse } from '@/api/actions'
import { fetchActions, fetchActionsCount, swipeAction } from '@/api/actions'
import type { SwipeDirection } from '@/data/types'

// Constants for pagination
const PAGE_SIZE = 50
const LOAD_MORE_THRESHOLD = 10 // Load more when less than this many actions left

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
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const loadedIdsRef = useRef<Set<number>>(new Set())
  const isLoadingMoreRef = useRef(false)

  // Load total count (fast endpoint)
  const loadCount = useCallback(async () => {
    try {
      const count = await fetchActionsCount(actionType)
      setTotalCount(count)
    } catch (err) {
      console.error('[useActions] Failed to load count:', err)
    }
  }, [actionType])

  // Load a batch of actions
  const loadActions = useCallback(
    async (append = false) => {
      if (isLoadingMoreRef.current && append) return

      if (!append) {
        setLoading(true)
        loadedIdsRef.current.clear()
      } else {
        isLoadingMoreRef.current = true
      }
      setError(null)

      try {
        const data = await fetchActions('pending', PAGE_SIZE, actionType)

        if (USE_MOCK_DATA && data.length === 0) {
          setActions(MOCK_ACTIONS)
        } else if (append) {
          // Filter out already loaded actions to avoid duplicates
          const newActions = data.filter((a) => !loadedIdsRef.current.has(a.id))
          newActions.forEach((a) => loadedIdsRef.current.add(a.id))
          setActions((prev) => [...prev, ...newActions])
        } else {
          setActions(data)
          data.forEach((a) => loadedIdsRef.current.add(a.id))
        }
      } catch (err) {
        if (USE_MOCK_DATA) {
          setActions(MOCK_ACTIONS)
        } else {
          setError(err instanceof Error ? err.message : 'Failed to load actions')
        }
      } finally {
        setLoading(false)
        isLoadingMoreRef.current = false
      }
    },
    [actionType]
  )

  // Initial load
  useEffect(() => {
    loadActions()
    loadCount()
  }, [loadActions, loadCount])

  // Load more when running low (only if we haven't already tried)
  const hasTriedLoadMore = useRef(false)
  useEffect(() => {
    if (
      actions.length > 0 &&
      actions.length < LOAD_MORE_THRESHOLD &&
      totalCount > actions.length &&
      !hasTriedLoadMore.current
    ) {
      hasTriedLoadMore.current = true
      loadActions(true)
    }
  }, [actions.length, totalCount, loadActions])

  // Reset load more flag when actions are refreshed
  useEffect(() => {
    if (actions.length >= LOAD_MORE_THRESHOLD || actions.length === 0) {
      hasTriedLoadMore.current = false
    }
  }, [actions.length])

  const handleSwipe = useCallback(
    async (
      actionId: number,
      direction: SwipeDirection,
      responseText?: string,
      snoozeMinutes?: number
    ) => {
      try {
        await swipeAction(actionId, direction, responseText, snoozeMinutes)
        // Remove the swiped action from the list and update count
        setActions((prev) => prev.filter((a) => a.id !== actionId))
        setTotalCount((prev) => Math.max(0, prev - 1))
        loadedIdsRef.current.delete(actionId)
      } catch (err) {
        // If backend fails, still remove the action locally (mock mode)
        setActions((prev) => prev.filter((a) => a.id !== actionId))
        setTotalCount((prev) => Math.max(0, prev - 1))
        loadedIdsRef.current.delete(actionId)
        console.error('[useActions] Failed to process swipe:', err)
      }
    },
    []
  )

  const refresh = useCallback(async () => {
    loadedIdsRef.current.clear()
    await Promise.all([loadActions(), loadCount()])
  }, [loadActions, loadCount])

  const currentAction = actions[0] || null

  return {
    actions,
    currentAction,
    totalCount,
    remainingCount: totalCount, // Alias for backwards compatibility
    loading,
    error,
    handleSwipe,
    refresh
  }
}
