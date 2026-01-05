import { motion, type PanInfo, useMotionValue, useTransform } from 'motion/react'
import { type ReactNode, useState } from 'react'
import type { SwipeDirection } from '@/data/types'
import { SwipeIndicators } from './SwipeIndicators'

interface SwipeableCardProps {
  children: ReactNode
  onSwipe: (direction: SwipeDirection) => void
  onSwipeStart?: () => void
  disabled?: boolean
}

const SWIPE_THRESHOLD_X = 120
const SWIPE_THRESHOLD_Y = 80

export function SwipeableCard({
  children,
  onSwipe,
  onSwipeStart,
  disabled = false
}: SwipeableCardProps) {
  const [isDragging, setIsDragging] = useState(false)

  const x = useMotionValue(0)
  const y = useMotionValue(0)

  // Rotate based on horizontal drag
  const rotate = useTransform(x, [-200, 200], [-15, 15])

  // Scale down slightly while dragging
  const scale = useTransform(x, [-200, -100, 0, 100, 200], [0.95, 0.98, 1, 0.98, 0.95])

  // Card opacity fades out as it's swiped away
  const opacity = useTransform(x, [-200, -150, 0, 150, 200], [0.5, 0.8, 1, 0.8, 0.5])

  const handleDragStart = () => {
    setIsDragging(true)
    onSwipeStart?.()
  }

  const handleDragEnd = (_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    setIsDragging(false)

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
        x: x.get() > 0 ? 300 : x.get() < 0 ? -300 : 0,
        y: y.get() < -50 ? -200 : 0,
        opacity: 0,
        transition: { duration: 0.3 }
      }}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
    >
      <div className="relative w-full h-full">
        {children}
        {isDragging && <SwipeIndicators x={x} y={y} />}
      </div>
    </motion.div>
  )
}
