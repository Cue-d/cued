import { AlertCircle } from 'lucide-react'
import { useCallback } from 'react'
import type { SwipeDirection } from '@/data/types'
import { useActions } from '@/hooks'
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { CardStack } from './CardStack'
import { Spinner } from '../ui/spinner'

export function ActionQueueView() {
  const { actions, loading, error, handleSwipe, refresh } = useActions()

  // Wrap handleSwipe for CardStack
  const onSwipe = useCallback(
    async (
      actionId: number,
      direction: SwipeDirection,
      responseText?: string,
      snoozeMinutes?: number
    ) => {
      await handleSwipe(actionId, direction, responseText, snoozeMinutes)
    },
    [handleSwipe]
  )

  if (loading) {
    return (
      <div className="w-full h-full bg-imessage-window-bg">
        <Empty className="border-0">
          <EmptyMedia>
            <Spinner />
          </EmptyMedia>
          <EmptyTitle>Loading Actions</EmptyTitle>
          <EmptyDescription>Getting your pending items...</EmptyDescription>
        </Empty>
      </div>
    )
  }

  if (error) {
    return (
      <div className="w-full h-full bg-imessage-window-bg">
        <Empty className="border-0">
          <EmptyMedia variant="icon">
            <AlertCircle className="w-6 h-6" />
          </EmptyMedia>
          <EmptyTitle>Something went wrong</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
          <button
            onClick={refresh}
            className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity"
          >
            Try Again
          </button>
        </Empty>
      </div>
    )
  }

  return (
    <div className="w-full h-full flex flex-col bg-imessage-window-bg">
      {/* Card Stack */}
      <div className="flex-1 overflow-hidden relative">
        <CardStack actions={actions} onSwipe={onSwipe} />
      </div>
    </div>
  )
}
