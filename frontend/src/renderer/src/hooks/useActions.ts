import { useCallback, useEffect, useState } from 'react'
import type { ActionResponse } from '@/api/actions'
import { fetchActions, swipeAction } from '@/api/actions'
import type { SwipeDirection } from '@/data/types'

export function useActions() {
  const [actions, setActions] = useState<ActionResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadActions = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await fetchActions('pending', 50)
      setActions(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load actions')
    } finally {
      setLoading(false)
    }
  }, [])

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
        setError(err instanceof Error ? err.message : 'Failed to process swipe')
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
