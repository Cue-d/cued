import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useMemo, useState } from 'react'
import type { ActionResponse } from '@/api/actions'
import { addContactContext } from '@/api/actions'
import type { SwipeDirection } from '@/data/types'
import { type ContactFormData, EODContactCard } from './EODContactCard'
import { MessageResponseCard } from './MessageResponseCard'
import { SwipeableCard } from './SwipeableCard'

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

  // Get visible cards (top 3)
  const visibleActions = useMemo(() => actions.slice(0, VISIBLE_CARDS), [actions])

  const handleResponseChange = useCallback((actionId: number, text: string) => {
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
          You can exhale now. New actions will appear here when messages need responses or you meet
          new people.
        </p>
      </div>
    )
  }

  return (
    <div className="relative w-full h-full max-w-md mx-auto">
      <AnimatePresence mode="popLayout">
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
              transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            >
              {isTop ? (
                <SwipeableCard
                  onSwipe={(direction) => handleSwipe(action, direction)}
                  disabled={isProcessing}
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

      {/* Card count indicator */}
      {actions.length > 1 && (
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 bg-muted/80 backdrop-blur-sm px-3 py-1.5 rounded-full">
          <span className="text-sm font-medium text-muted-foreground">
            {actions.length} remaining
          </span>
        </div>
      )}
    </div>
  )
}
