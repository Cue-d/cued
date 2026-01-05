import { Check, Clock, X } from 'lucide-react'
import { type MotionValue, motion, useTransform } from 'motion/react'

interface SwipeIndicatorsProps {
  x: MotionValue<number>
  y: MotionValue<number>
}

export function SwipeIndicators({ x, y }: SwipeIndicatorsProps) {
  // Opacity for right swipe indicator (Take Action)
  const rightOpacity = useTransform(x, [0, 100], [0, 1])
  // Opacity for left swipe indicator (No Action)
  const leftOpacity = useTransform(x, [-100, 0], [1, 0])
  // Opacity for up swipe indicator (Snooze)
  const upOpacity = useTransform(y, [-80, 0], [1, 0])

  return (
    <>
      {/* Right indicator - Take Action */}
      <motion.div
        className="absolute right-6 top-1/2 -translate-y-1/2 flex items-center gap-2 text-emerald-500 pointer-events-none"
        style={{ opacity: rightOpacity }}
      >
        <Check className="w-8 h-8" strokeWidth={3} />
        <span className="text-lg font-semibold">Send</span>
      </motion.div>

      {/* Left indicator - No Action */}
      <motion.div
        className="absolute left-6 top-1/2 -translate-y-1/2 flex items-center gap-2 text-rose-500 pointer-events-none"
        style={{ opacity: leftOpacity }}
      >
        <span className="text-lg font-semibold">Skip</span>
        <X className="w-8 h-8" strokeWidth={3} />
      </motion.div>

      {/* Up indicator - Snooze */}
      <motion.div
        className="absolute top-6 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 text-amber-500 pointer-events-none"
        style={{ opacity: upOpacity }}
      >
        <Clock className="w-7 h-7" strokeWidth={2.5} />
        <span className="text-sm font-semibold">Snooze</span>
      </motion.div>
    </>
  )
}
