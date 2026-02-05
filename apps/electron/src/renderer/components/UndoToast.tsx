import { useEffect } from "react"
import { X } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { cn } from "@cued/ui"

const AUTO_DISMISS_MS = 5000

const TOAST_STYLE: React.CSSProperties = {
  backgroundColor: "rgba(38, 38, 38, 0.95)",
  backdropFilter: "blur(20px)",
  border: "1px solid rgba(255, 255, 255, 0.1)",
}

const ANIMATION_HIDDEN = { opacity: 0, y: -20, scale: 0.95 }
const ANIMATION_VISIBLE = { opacity: 1, y: 0, scale: 1 }
const ANIMATION_TRANSITION = { type: "spring" as const, stiffness: 400, damping: 30 }

interface UndoToastProps {
  visible: boolean
  message: string
  onUndo: () => void
  onDismiss: () => void
}

export function UndoToast({ visible, message, onUndo, onDismiss }: UndoToastProps): React.ReactElement {
  useEffect(() => {
    if (!visible) return
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [visible, onDismiss])

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={ANIMATION_HIDDEN}
          animate={ANIMATION_VISIBLE}
          exit={ANIMATION_HIDDEN}
          transition={ANIMATION_TRANSITION}
          className={cn(
            "fixed top-4 right-4 z-50",
            "flex items-center gap-3 px-4 py-3 rounded-lg",
            "shadow-lg border"
          )}
          style={TOAST_STYLE}
        >
          <span className="text-sm font-medium">{message}</span>
          <button
            type="button"
            onClick={onUndo}
            className="text-sm font-semibold text-primary hover:text-primary/80 transition-colors"
          >
            Undo
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="p-1 rounded hover:bg-muted/50 transition-colors text-muted-foreground"
          >
            <X className="w-4 h-4" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
