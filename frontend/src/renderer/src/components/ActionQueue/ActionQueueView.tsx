import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef } from 'react'
import { useActions } from '@/hooks'
import { BadgeAlertIcon, type BadgeAlertIconHandle } from '@/components/ui/badge-alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { LoaderPinwheelIcon, type LoaderPinwheelIconHandle } from '@/components/ui/loader-pinwheel'
import { CardStack } from './CardStack'

type ViewState = 'loading' | 'error' | 'content'

export function ActionQueueView() {
  const { actions, totalCount, loading, error, handleSwipe, refresh } = useActions()

  // Refs for animated icons
  const loaderRef = useRef<LoaderPinwheelIconHandle>(null)
  const alertRef = useRef<BadgeAlertIconHandle>(null)

  // Start loader animation when loading state is active
  useEffect(() => {
    if (!loading) return
    const timer = setTimeout(() => {
      loaderRef.current?.startAnimation()
    }, 100)
    return () => clearTimeout(timer)
  }, [loading])

  // Trigger alert animation when error state appears
  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => {
      alertRef.current?.startAnimation()
    }, 200)
    return () => clearTimeout(timer)
  }, [error])

  // Determine current view state
  const viewState: ViewState = loading ? 'loading' : error ? 'error' : 'content'

  return (
    <div className="w-full h-full flex flex-col bg-imessage-window-bg overflow-hidden">
      <AnimatePresence mode="wait">
        {viewState === 'loading' && (
          <motion.div
            key="loading"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95, y: -10 }}
            transition={{
              type: 'spring',
              stiffness: 300,
              damping: 30,
              opacity: { duration: 0.2 }
            }}
            className="flex-1 flex items-center justify-center"
          >
            <Empty className="border-0">
              <EmptyHeader>
                <EmptyMedia>
                  <LoaderPinwheelIcon ref={loaderRef} size={24} />
                </EmptyMedia>
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.15, duration: 0.3 }}
                >
                  <EmptyTitle>Loading Actions</EmptyTitle>
                </motion.div>
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.25, duration: 0.3 }}
                >
                  <EmptyDescription>Getting your pending items...</EmptyDescription>
                </motion.div>
              </EmptyHeader>
            </Empty>
          </motion.div>
        )}

        {viewState === 'error' && (
          <motion.div
            key="error"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95, y: -10 }}
            transition={{
              type: 'spring',
              stiffness: 300,
              damping: 30,
              opacity: { duration: 0.2 }
            }}
            className="flex-1 flex items-center justify-center"
          >
            <Empty className="border-0">
              <EmptyMedia variant="icon">
                <BadgeAlertIcon ref={alertRef} size={24} className="text-destructive" />
              </EmptyMedia>
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15, duration: 0.3 }}
              >
                <EmptyTitle>Something went wrong</EmptyTitle>
              </motion.div>
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.25, duration: 0.3 }}
              >
                <EmptyDescription>{error}</EmptyDescription>
              </motion.div>
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.35, duration: 0.3 }}
              >
                <Button onClick={refresh} className="mt-2">
                  Try Again
                </Button>
              </motion.div>
            </Empty>
          </motion.div>
        )}

        {viewState === 'content' && (
          <motion.div
            key="content"
            initial={{ opacity: 0, scale: 0.98, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{
              type: 'spring',
              stiffness: 300,
              damping: 30,
              opacity: { duration: 0.2 }
            }}
            className="flex-1 overflow-hidden relative"
          >
            <CardStack actions={actions} totalCount={totalCount} onSwipe={handleSwipe} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
