import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ActionResponse } from '@/api/actions'
import { addContactContext } from '@/api/actions'
import type { SwipeDirection } from '@/data/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { type ContactFormData, EODContactCard } from './EODContactCard'
import { MessageResponseCard } from './MessageResponseCard'
import { SwipeableCard } from './SwipeableCard'
import { Button } from '../ui/button'

interface CardStackProps {
  actions: ActionResponse[]
  onSwipe: (
    actionId: number,
    direction: SwipeDirection,
    responseText?: string,
    snoozeMinutes?: number
  ) => Promise<void>
}

const VISIBLE_CARDS = 3

export function CardStack({ actions, onSwipe }: CardStackProps) {
  // State for the current card's input
  const [responseTexts, setResponseTexts] = useState<Record<number, string>>({})
  const [contactForms, setContactForms] = useState<Record<number, ContactFormData>>({})
  const [isProcessing, setIsProcessing] = useState(false)
  // Track which action should be swiped (for button-triggered animations)
  const [triggerSwipe, setTriggerSwipe] = useState<{
    actionId: number
    direction: SwipeDirection
  } | null>(null)

  // Get visible cards (top 3)
  const visibleActions = useMemo(() => actions.slice(0, VISIBLE_CARDS), [actions])

  const handleResponseChange = useCallback((actionId: number, text: string) => {
    console.log('[CardStack] handleResponseChange:', { actionId, text })
    setResponseTexts((prev) => ({ ...prev, [actionId]: text }))
  }, [])

  const handleContactFormChange = useCallback((actionId: number, data: ContactFormData) => {
    setContactForms((prev) => ({ ...prev, [actionId]: data }))
  }, [])

  const handleSwipe = useCallback(
    async (action: ActionResponse, direction: SwipeDirection) => {
      if (isProcessing) return
      setIsProcessing(true)

      try {
        if (action.type === 'respond_to_message') {
          const responseText = responseTexts[action.id]
          console.log('[CardStack] handleSwipe called:', {
            actionId: action.id,
            direction,
            responseText,
            responseTextsState: responseTexts
          })
          // Only pass response text for right swipe
          if (direction === 'right' && responseText) {
            await onSwipe(action.id, direction, responseText)
          } else if (direction === 'up') {
            // Snooze for 1 hour by default
            await onSwipe(action.id, direction, undefined, 60)
          } else {
            await onSwipe(action.id, direction)
          }
        } else if (action.type === 'eod_contact') {
          const formData = contactForms[action.id]
          // Save contact context on right swipe
          if (direction === 'right' && action.person_id && formData?.notes) {
            await addContactContext(action.person_id, formData.notes)
          }
          if (direction === 'up') {
            await onSwipe(action.id, direction, undefined, 60)
          } else {
            await onSwipe(action.id, direction)
          }
        } else {
          // follow_up or other types
          if (direction === 'up') {
            await onSwipe(action.id, direction, undefined, 60)
          } else {
            await onSwipe(action.id, direction)
          }
        }
      } finally {
        setIsProcessing(false)
        // Clean up state for this action
        setResponseTexts((prev) => {
          const next = { ...prev }
          delete next[action.id]
          return next
        })
        setContactForms((prev) => {
          const next = { ...prev }
          delete next[action.id]
          return next
        })
      }
    },
    [isProcessing, responseTexts, contactForms, onSwipe]
  )

  // Handle button clicks to trigger swipe animation
  const handleButtonSwipe = useCallback(
    (direction: SwipeDirection) => {
      if (actions.length === 0 || isProcessing) return
      const topAction = actions[0]
      // Trigger the animation by setting triggerSwipe state
      setTriggerSwipe({ actionId: topAction.id, direction })
    },
    [actions, isProcessing]
  )

  // Reset triggerSwipe after it's been processed
  useEffect(() => {
    if (triggerSwipe) {
      // Reset quickly to allow next swipe
      const timer = setTimeout(() => {
        setTriggerSwipe(null)
      }, 300)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [triggerSwipe])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }

      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        handleButtonSwipe('left')
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        handleButtonSwipe('right')
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        handleButtonSwipe('up')
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleButtonSwipe])

  if (actions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-8">
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="text-6xl mb-4"
        >
          🎉
        </motion.div>
        <h2 className="text-2xl font-semibold text-foreground mb-2">All caught up!</h2>
        <p className="text-muted-foreground max-w-sm">
          You can exhale now. New actions will appear here.
        </p>
      </div>
    )
  }

  return (
    <div className="relative w-full h-full flex flex-col">
      {/* Header with count */}
      <div className="shrink-0 flex items-center justify-center py-3">
        <span className="text-lg font-semibold text-foreground">{actions.length} Left</span>
      </div>

      {/* Card Stack Area */}
      <div className="flex-1 relative max-w-lg mx-auto w-full">
        <AnimatePresence mode="popLayout" initial={false}>
          {visibleActions.map((action, index) => {
            // Only the top card is interactive
            const isTop = index === 0
            // Create stack effect with scale and y offset
            const stackScale = 1 - index * 0.04
            const stackY = index * 8

            return (
              <motion.div
                key={action.id}
                className="absolute inset-4"
                style={{
                  zIndex: VISIBLE_CARDS - index
                }}
                initial={{
                  scale: stackScale,
                  y: stackY,
                  opacity: index === 0 ? 0 : 1
                }}
                animate={{
                  scale: stackScale,
                  y: stackY,
                  opacity: 1
                }}
                exit={{
                  scale: stackScale * 0.95,
                  y: stackY,
                  opacity: 0
                }}
                transition={{
                  type: 'spring',
                  stiffness: 400,
                  damping: 30
                }}
                layout
              >
                {isTop ? (
                  <SwipeableCard
                    onSwipe={(direction) => handleSwipe(action, direction)}
                    disabled={isProcessing}
                    triggerSwipe={
                      triggerSwipe?.actionId === action.id ? triggerSwipe.direction : null
                    }
                  >
                    {action.type === 'eod_contact' ? (
                      <EODContactCard
                        action={action}
                        formData={
                          contactForms[action.id] || {
                            name: action.person_name || '',
                            tags: '',
                            notes: ''
                          }
                        }
                        onFormChange={(data) => handleContactFormChange(action.id, data)}
                      />
                    ) : (
                      <MessageResponseCard
                        action={action}
                        responseText={responseTexts[action.id] || ''}
                        onResponseChange={(text) => handleResponseChange(action.id, text)}
                      />
                    )}
                  </SwipeableCard>
                ) : (
                  // Background cards (not interactive)
                  <div className="w-full h-full pointer-events-none">
                    {action.type === 'eod_contact' ? (
                      <EODContactCard
                        action={action}
                        formData={{
                          name: action.person_name || '',
                          tags: '',
                          notes: ''
                        }}
                        onFormChange={() => {}}
                      />
                    ) : (
                      <MessageResponseCard
                        action={action}
                        responseText=""
                        onResponseChange={() => {}}
                      />
                    )}
                  </div>
                )}
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>

      {/* Bottom Action Buttons */}
      <div className="flex items-center justify-center shrink-0 px-4 pb-6 pt-2">
        <div className="flex items-center gap-4 max-w-md w-full">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="secondary"
                onClick={() => handleButtonSwipe('left')}
                disabled={isProcessing}
                size="lg"
                className="flex-1"
              >
                Discard
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>
                Press{' '}
                <kbd className="ml-1 px-1.5 py-0.5 bg-muted/20 rounded text-xs font-mono">←</kbd>
              </p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                onClick={() => handleButtonSwipe('up')}
                disabled={isProcessing}
                size="lg"
                className="flex-1"
              >
                Snooze
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>
                Press{' '}
                <kbd className="ml-1 px-1.5 py-0.5 bg-muted/20 rounded text-xs font-mono">↑</kbd>
              </p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="default"
                onClick={() => handleButtonSwipe('right')}
                disabled={isProcessing}
                size="lg"
                className="flex-1"
              >
                Send
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>
                Press{' '}
                <kbd className="ml-1 px-1.5 py-0.5 bg-muted/20 rounded text-xs font-mono">→</kbd>
              </p>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}
