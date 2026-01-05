import { motion, type PanInfo, useMotionValue, useTransform, animate } from 'motion/react'
import { Check, Clock, X } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'
import type { SwipeDirection } from '@/data/types'

interface SwipeableCardProps {
  children: ReactNode
  onSwipe: (direction: SwipeDirection) => void
  onSwipeStart?: () => void
  disabled?: boolean
  triggerSwipe?: SwipeDirection | null
}

const SWIPE_THRESHOLD_X = 120
const SWIPE_THRESHOLD_Y = 80

export function SwipeableCard({
  children,
  onSwipe,
  onSwipeStart,
  disabled = false,
  triggerSwipe = null
}: SwipeableCardProps) {
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const isAnimatingRef = useRef(false)

  // Rotate based on horizontal drag
  const rotate = useTransform(x, [-200, 200], [-15, 15])

  // Scale down slightly while dragging
  const scale = useTransform(x, [-200, -100, 0, 100, 200], [0.95, 0.98, 1, 0.98, 0.95])

  // Card opacity fades out as it's swiped away
  const opacity = useTransform(x, [-200, -150, 0, 150, 200], [0.5, 0.8, 1, 0.8, 0.5])

  // Overlay opacity increases as card is swiped farther (0 at center, 0.95 at threshold)
  const rightOverlayOpacity = useTransform(x, [0, SWIPE_THRESHOLD_X], [0, 0.95])
  const leftOverlayOpacity = useTransform(x, [-SWIPE_THRESHOLD_X, 0], [0.9, 0])
  const upOverlayOpacity = useTransform(y, [-SWIPE_THRESHOLD_Y, 0], [0.9, 0])

  const handleDragStart = () => {
    onSwipeStart?.()
  }

  const handleDragEnd = (_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    const offsetX = info.offset.x
    const offsetY = info.offset.y
    const velocityX = info.velocity.x
    const velocityY = info.velocity.y

    // Check for swipe with offset + velocity
    if (offsetX > SWIPE_THRESHOLD_X || velocityX > 500) {
      onSwipe('right')
    } else if (offsetX < -SWIPE_THRESHOLD_X || velocityX < -500) {
      onSwipe('left')
    } else if (offsetY < -SWIPE_THRESHOLD_Y || velocityY < -300) {
      onSwipe('up')
    }
  }

  // Handle programmatic swipe trigger from buttons/keyboard
  useEffect(() => {
    if (triggerSwipe && !isAnimatingRef.current) {
      isAnimatingRef.current = true
      onSwipeStart?.()

      // Phase 1: Animate to show overlay (anticipation)
      let peekX = 0
      let peekY = 0
      // Phase 2: Animate off screen
      let exitX = 0
      let exitY = 0

      switch (triggerSwipe) {
        case 'right':
          peekX = SWIPE_THRESHOLD_X + 20 // Just past threshold to show overlay
          exitX = 400
          break
        case 'left':
          peekX = -(SWIPE_THRESHOLD_X + 20)
          exitX = -400
          break
        case 'up':
          peekY = -(SWIPE_THRESHOLD_Y + 20)
          exitY = -300
          break
      }

      // Phase 1: Quick peek to show the overlay
      animate(x, peekX, {
        type: 'spring',
        stiffness: 500,
        damping: 30,
        mass: 0.8
      })
      animate(y, peekY, {
        type: 'spring',
        stiffness: 500,
        damping: 30,
        mass: 0.8
      })

      // Phase 2: After brief pause, swipe off and trigger action
      setTimeout(() => {
        // Trigger the actual swipe action
        onSwipe(triggerSwipe)

        // Animate card off screen with a graceful exit
        animate(x, exitX, {
          type: 'spring',
          stiffness: 300,
          damping: 25,
          mass: 0.6
        })
        animate(y, exitY, {
          type: 'spring',
          stiffness: 300,
          damping: 25,
          mass: 0.6
        })
      }, 150)

      // Reset after full animation
      setTimeout(() => {
        isAnimatingRef.current = false
      }, 400)
    } else if (!triggerSwipe && isAnimatingRef.current) {
      // Reset when triggerSwipe is cleared
      isAnimatingRef.current = false
    }
  }, [triggerSwipe, x, y, onSwipe, onSwipeStart])

  return (
    <motion.div
      className="absolute inset-0 cursor-grab active:cursor-grabbing"
      style={{ x, y, rotate, scale, opacity }}
      drag={!disabled}
      dragConstraints={{ left: 0, right: 0, top: 0, bottom: 0 }}
      dragElastic={0.7}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      whileTap={{ cursor: 'grabbing' }}
      initial={{ scale: 0.95, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{
        opacity: 0,
        scale: 0.9,
        transition: {
          type: 'spring',
          stiffness: 400,
          damping: 30
        }
      }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
    >
      <div className="relative w-full h-full overflow-hidden rounded-2xl">
        {children}

        {/* Right swipe overlay (Done - green/teal) */}
        <motion.div
          className="absolute inset-0 bg-[#00806B] rounded-2xl flex items-center justify-center pointer-events-none"
          style={{ opacity: rightOverlayOpacity }}
        >
          <div className="flex flex-col items-center gap-2">
            <div className="w-16 h-16 rounded-full bg-white/20 flex items-center justify-center">
              <Check className="w-10 h-10 text-white" strokeWidth={3} />
            </div>
            <span className="text-xl font-semibold text-white">Send</span>
          </div>
        </motion.div>

        {/* Left swipe overlay (Skip - gray) */}
        <motion.div
          className="absolute inset-0 bg-neutral-600 rounded-2xl flex items-center justify-center pointer-events-none"
          style={{ opacity: leftOverlayOpacity }}
        >
          <div className="flex flex-col items-center gap-2">
            <div className="w-16 h-16 rounded-full bg-white/20 flex items-center justify-center">
              <X className="w-10 h-10 text-white" strokeWidth={3} />
            </div>
            <span className="text-xl font-semibold text-white">Discard</span>
          </div>
        </motion.div>

        {/* Up swipe overlay (Snooze - muted amber) */}
        <motion.div
          className="absolute inset-0 bg-amber-700 rounded-2xl flex items-center justify-center pointer-events-none"
          style={{ opacity: upOverlayOpacity }}
        >
          <div className="flex flex-col items-center gap-2">
            <div className="w-16 h-16 rounded-full bg-white/20 flex items-center justify-center">
              <Clock className="w-10 h-10 text-white" strokeWidth={2.5} />
            </div>
            <span className="text-xl font-semibold text-white">Snooze</span>
          </div>
        </motion.div>
      </div>
    </motion.div>
  )
}
