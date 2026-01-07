import { motion, AnimatePresence } from 'motion/react'
import { useState, useEffect } from 'react'
import { Target, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useView } from '@/hooks/useView'
import { VIEWS, VIEW_ORDER, type ViewType } from '@/types/views'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Target,
  MessageSquare
}

export function FloatingNavigationPill() {
  const { currentView, setView } = useView()
  const [isExpanded, setIsExpanded] = useState(false)
  const [isHovered, setIsHovered] = useState(false)

  // Handle hover state changes
  const handleMouseEnter = () => {
    setIsHovered(true)
    setIsExpanded(true)
  }

  const handleMouseLeave = () => {
    setIsHovered(false)
  }

  // Auto-collapse after delay when not hovered
  useEffect(() => {
    if (!isHovered) {
      const timer = setTimeout(() => {
        setIsExpanded(false)
      }, 500) // Longer delay for smoother collapse
      return () => clearTimeout(timer)
    }
    return undefined
  }, [isHovered])

  const handleViewClick = (viewId: ViewType) => {
    setView(viewId)
    setIsExpanded(false)
    setIsHovered(false)
  }

  return (
    <div
      className="fixed left-6 top-1/2 -translate-y-1/2 z-50"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <motion.div
        className={cn(
          'flex flex-col items-center gap-2 rounded-full bg-background/80 backdrop-blur-md border border-border/50 shadow-lg',
          isExpanded ? 'px-2 py-3' : 'px-2 py-2'
        )}
        animate={{
          height: isExpanded ? 'auto' : 'auto',
          scale: isHovered ? 1.02 : 1
        }}
        transition={{
          duration: 0.3,
          ease: [0.4, 0, 0.2, 1] // Custom cubic-bezier for smoother animation
        }}
      >
        <AnimatePresence mode="popLayout">
          {VIEW_ORDER.map((viewId, index) => {
            const view = VIEWS[viewId]
            const IconComponent = ICON_MAP[view.icon]
            const isActive = currentView === viewId

            if (!isExpanded && !isActive) {
              return null
            }

            return (
              <motion.button
                key={viewId}
                onClick={() => handleViewClick(viewId)}
                className={cn(
                  'flex items-center justify-center rounded-full transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent',
                  'w-10 h-10'
                )}
                initial={{
                  opacity: 0,
                  scale: 0.6,
                  y: -10
                }}
                animate={{
                  opacity: 1,
                  scale: 1,
                  y: 0
                }}
                exit={{
                  opacity: 0,
                  scale: 0.6,
                  y: -10
                }}
                transition={{
                  duration: 0.25,
                  ease: [0.4, 0, 0.2, 1],
                  delay: isExpanded ? index * 0.03 : 0 // Stagger animation when expanding
                }}
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
                layout
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center justify-center w-full h-full">
                      {IconComponent && <IconComponent className="w-5 h-5" />}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    <div className="flex flex-col items-start gap-0.5">
                      <span>{view.label}</span>
                      {view.shortcut && (
                        <span className="text-[10px] opacity-70">{view.shortcut}</span>
                      )}
                    </div>
                  </TooltipContent>
                </Tooltip>
              </motion.button>
            )
          })}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}
