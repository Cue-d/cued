import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActionResponse } from '@/api/actions'
import { addContactContext } from '@/api/actions'
import type { SwipeDirection } from '@/data/types'
import { PartyPopperIcon, type PartyPopperIconHandle } from '@/components/ui/party-popper'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { type ContactFormData, EODContactCard, type EODContactCardRef } from './EODContactCard'
import { MessageResponseCard, type MessageResponseCardRef } from './MessageResponseCard'
import { SwipeableCard } from './SwipeableCard'
import { Button } from '../ui/button'

interface CardStackProps {
  actions: ActionResponse[]
  totalCount: number
  onSwipe: (
    actionId: number,
    direction: SwipeDirection,
    responseText?: string,
    snoozeMinutes?: number
  ) => Promise<void>
}

const VISIBLE_CARDS = 3

export function CardStack({ actions, totalCount, onSwipe }: CardStackProps) {
  // State for the current card's input
  const [responseTexts, setResponseTexts] = useState<Record<number, string>>({})
  const [contactForms, setContactForms] = useState<Record<number, ContactFormData>>({})
  const [isProcessing, setIsProcessing] = useState(false)
  // Track which action should be swiped (for button-triggered animations)
  const [triggerSwipe, setTriggerSwipe] = useState<{
    actionId: number
    direction: SwipeDirection
  } | null>(null)

  // Refs for focus management
  const containerRef = useRef<HTMLDivElement>(null)
  const messageCardRef = useRef<MessageResponseCardRef>(null)
  const eodCardRef = useRef<EODContactCardRef>(null)

  // Focus the text input in the current card
  const focusCardInput = useCallback(() => {
    if (actions.length === 0) return
    const topAction = actions[0]
    if (topAction.type === 'eod_contact') {
      eodCardRef.current?.focusInput()
    } else {
      messageCardRef.current?.focusInput()
    }
  }, [actions])

  // Extract the top action ID for dependency tracking
  const topActionId = actions.length > 0 ? actions[0]?.id : null

  // Auto-focus container on mount and when top action changes
  useEffect(() => {
    // Small delay to ensure the card has rendered
    const timer = setTimeout(() => {
      containerRef.current?.focus()
    }, 50)
    return () => clearTimeout(timer)
  }, [topActionId])

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
        // Handle pre-swipe actions
        if (direction === 'right') {
          if (action.type === 'respond_to_message') {
            const responseText = responseTexts[action.id]
            if (responseText) {
              await onSwipe(action.id, direction, responseText)
              return
            }
          } else if (action.type === 'eod_contact') {
            const formData = contactForms[action.id]
            if (action.person_id && formData?.notes) {
              await addContactContext(action.person_id, formData.notes)
            }
          }
        }

        // Default swipe handling (snooze uses 60 min default)
        const snoozeMinutes = direction === 'up' ? 60 : undefined
        await onSwipe(action.id, direction, undefined, snoozeMinutes)
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
    if (!triggerSwipe) return
    const timer = setTimeout(() => {
      setTriggerSwipe(null)
    }, 300)
    return () => clearTimeout(timer)
  }, [triggerSwipe])

  // Handle keyboard navigation on the container
  const handleContainerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Ignore keyboard shortcuts when typing in inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }

      // Tab focuses the text input
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault()
        focusCardInput()
        return
      }

      // Arrow keys for swipe actions
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
    },
    [focusCardInput, handleButtonSwipe]
  )

  // Handle Escape key from inputs to return focus to container
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // If we're in an input, refocus the container for arrow key navigation
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
          e.preventDefault()
          containerRef.current?.focus()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Ref for animated party popper icon
  const partyPopperRef = useRef<PartyPopperIconHandle>(null)

  // Trigger party popper animation when empty state mounts
  useEffect(() => {
    if (actions.length > 0) return
    const timer = setTimeout(() => {
      partyPopperRef.current?.startAnimation()
    }, 200)
    return () => clearTimeout(timer)
  }, [actions.length])

  if (actions.length === 0) {
    return (
      <motion.div
        key="empty-state"
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: -10 }}
        transition={{
          type: 'spring',
          stiffness: 300,
          damping: 30,
          opacity: { duration: 0.2 }
        }}
        className="flex flex-col items-center justify-center h-full"
      >
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PartyPopperIcon ref={partyPopperRef} size={24} />
            </EmptyMedia>
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15, duration: 0.3 }}
            >
              <EmptyTitle>All caught up!</EmptyTitle>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.25, duration: 0.3 }}
            >
              <EmptyDescription>You can exhale now. New actions will appear here.</EmptyDescription>
            </motion.div>
          </EmptyHeader>
        </Empty>
      </motion.div>
    )
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleContainerKeyDown}
      className="relative w-full h-full flex flex-col outline-none"
    >
      {/* Header with count */}
      <div className="shrink-0 flex items-center justify-center py-3">
        <span className="text-lg font-semibold text-foreground">{totalCount} Left</span>
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
                        ref={eodCardRef}
                        action={action}
                        formData={
                          contactForms[action.id] || {
                            name: action.person_name || '',
                            tags: '',
                            notes: ''
                          }
                        }
                        onFormChange={(data) => handleContactFormChange(action.id, data)}
                        autoFocus={false}
                      />
                    ) : (
                      <MessageResponseCard
                        ref={messageCardRef}
                        action={action}
                        responseText={responseTexts[action.id] || ''}
                        onResponseChange={(text) => handleResponseChange(action.id, text)}
                        autoFocus={false}
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
                        autoFocus={false}
                      />
                    ) : (
                      <MessageResponseCard
                        action={action}
                        responseText=""
                        onResponseChange={() => {}}
                        autoFocus={false}
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
                tabIndex={-1}
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
                tabIndex={-1}
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
                tabIndex={-1}
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
