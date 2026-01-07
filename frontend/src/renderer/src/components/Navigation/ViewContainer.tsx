import { AnimatePresence, motion } from 'motion/react'
import { useView } from '@/hooks/useView'
import { ActionQueueView } from '@/components/ActionQueue'
import { ChatView } from '@/components/ChatView'
import { useEffect, useRef } from 'react'

const VIEW_COMPONENTS = {
  'action-queue': ActionQueueView,
  chat: ChatView
}

export function ViewContainer() {
  const { currentView } = useView()
  const CurrentComponent = VIEW_COMPONENTS[currentView]
  const containerRef = useRef<HTMLDivElement>(null)

  // Smooth scroll to top when view changes
  useEffect(() => {
    if (containerRef.current) {
      const startScroll = containerRef.current.scrollTop
      const startTime = performance.now()
      const duration = 400 // 400ms scroll animation

      const animateScroll = (currentTime: number) => {
        const elapsed = currentTime - startTime
        const progress = Math.min(elapsed / duration, 1)

        // Easing function (ease-out cubic)
        const easeOutCubic = 1 - Math.pow(1 - progress, 3)

        if (containerRef.current) {
          containerRef.current.scrollTop = startScroll * (1 - easeOutCubic)
        }

        if (progress < 1) {
          requestAnimationFrame(animateScroll)
        }
      }

      requestAnimationFrame(animateScroll)
    }
  }, [currentView])

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-auto">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={currentView}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          transition={{
            duration: 0.3,
            ease: [0.4, 0, 0.2, 1] // Smooth cubic-bezier
          }}
          className="w-full h-full"
        >
          <CurrentComponent />
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
