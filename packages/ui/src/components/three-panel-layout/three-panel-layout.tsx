import * as React from "react"
import { type AnimatedIconHandle } from "../../hooks/use-animated-icon"
import { cn } from "../../lib/utils"

const STORAGE_PREFIX = "three-panel-"
const MIN_LIST_WIDTH = 280
const MAX_LIST_WIDTH = 480
const DEFAULT_LIST_WIDTH = 320

interface ThreePanelLayoutProps {
  /** Unique key for persisting panel widths */
  storageKey: string
  /** Content for the list panel (middle) */
  listPanel: React.ReactNode
  /** Content for the detail panel (right) */
  detailPanel: React.ReactNode
  /** Optional header for the list panel */
  listHeader?: React.ReactNode
  /** Optional header for the detail panel */
  detailHeader?: React.ReactNode
  /** Whether to show the detail panel */
  showDetail?: boolean
  /** Additional class for the container */
  className?: string
}

interface ThreePanelContextValue {
  listWidth: number
  setListWidth: (width: number) => void
}

const ThreePanelContext = React.createContext<ThreePanelContextValue | null>(null)

export function useThreePanelContext() {
  const context = React.useContext(ThreePanelContext)
  if (!context) {
    throw new Error("useThreePanelContext must be used within a ThreePanelLayout")
  }
  return context
}

/**
 * ThreePanelLayout - A resizable 2-panel layout (list + detail) that works within the existing sidebar shell.
 * The global AppSidebar is handled by the parent layout, so this component only manages the list and detail panels.
 */
export function ThreePanelLayout({
  storageKey,
  listPanel,
  detailPanel,
  listHeader,
  detailHeader,
  showDetail = true,
  className,
}: ThreePanelLayoutProps) {
  const [listWidth, setListWidthState] = React.useState(DEFAULT_LIST_WIDTH)
  const [isResizing, setIsResizing] = React.useState(false)
  const containerRef = React.useRef<HTMLDivElement>(null)

  // Load persisted width on mount
  React.useEffect(() => {
    const stored = localStorage.getItem(`${STORAGE_PREFIX}${storageKey}-list-width`)
    if (stored) {
      const width = parseInt(stored, 10)
      if (!isNaN(width) && width >= MIN_LIST_WIDTH && width <= MAX_LIST_WIDTH) {
        setListWidthState(width)
      }
    }
  }, [storageKey])

  const setListWidth = React.useCallback(
    (width: number) => {
      const clampedWidth = Math.max(MIN_LIST_WIDTH, Math.min(MAX_LIST_WIDTH, width))
      setListWidthState(clampedWidth)
      localStorage.setItem(`${STORAGE_PREFIX}${storageKey}-list-width`, String(clampedWidth))
    },
    [storageKey]
  )

  // Handle resize drag
  const handleMouseDown = React.useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      setIsResizing(true)

      const startX = e.clientX
      const startWidth = listWidth

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - startX
        setListWidth(startWidth + delta)
      }

      const handleMouseUp = () => {
        setIsResizing(false)
        document.removeEventListener("mousemove", handleMouseMove)
        document.removeEventListener("mouseup", handleMouseUp)
      }

      document.addEventListener("mousemove", handleMouseMove)
      document.addEventListener("mouseup", handleMouseUp)
    },
    [listWidth, setListWidth]
  )

  const contextValue = React.useMemo(
    () => ({ listWidth, setListWidth }),
    [listWidth, setListWidth]
  )

  return (
    <ThreePanelContext.Provider value={contextValue}>
      <div
        ref={containerRef}
        className={cn(
          "flex h-full min-h-0 overflow-hidden",
          isResizing && "select-none cursor-col-resize",
          className
        )}
      >
        {/* List Panel */}
        <div
          className="flex flex-col h-full min-h-0 bg-sidebar border-r border-sidebar-border shrink-0"
          style={{ width: listWidth }}
        >
          {listHeader && (
            <div className="shrink-0 border-b border-sidebar-border">
              {listHeader}
            </div>
          )}
          <div className="flex-1 min-h-0 overflow-hidden">
            {listPanel}
          </div>
        </div>

        {/* Resize Handle */}
        <div
          className={cn(
            "w-1 shrink-0 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors",
            isResizing && "bg-primary/30"
          )}
          onMouseDown={handleMouseDown}
        />

        {/* Detail Panel */}
        {showDetail && (
          <div className="flex-1 min-w-0 flex flex-col h-full min-h-0 bg-background">
            {detailHeader && (
              <div className="shrink-0 border-b">
                {detailHeader}
              </div>
            )}
            <div className="flex-1 min-h-0 overflow-hidden">
              {detailPanel}
            </div>
          </div>
        )}
      </div>
    </ThreePanelContext.Provider>
  )
}

/**
 * PanelHeader - A consistent header for panels with title and optional actions
 */
interface PanelHeaderProps {
  title?: string
  children?: React.ReactNode
  className?: string
}

export function PanelHeader({ title, children, className }: PanelHeaderProps) {
  return (
    <div className={cn("flex items-center justify-between h-14 px-4", className)}>
      {title && <h2 className="text-lg font-semibold">{title}</h2>}
      {children}
    </div>
  )
}

/**
 * PanelContent - Wrapper for panel content with consistent padding and scroll
 */
interface PanelContentProps {
  children: React.ReactNode
  className?: string
  scrollable?: boolean
}

export function PanelContent({ children, className, scrollable = true }: PanelContentProps) {
  return (
    <div
      className={cn(
        "h-full",
        scrollable && "overflow-y-auto",
        className
      )}
    >
      {children}
    </div>
  )
}

/**
 * ListItem - A consistent list item for the list panel
 */
interface ListItemProps {
  children: React.ReactNode
  selected?: boolean
  onClick?: () => void
  className?: string
}

export function ListItem({ children, selected, onClick, className }: ListItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full text-left px-3 py-2.5 rounded-lg transition-colors",
        selected
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "hover:bg-sidebar-accent/50",
        className
      )}
    >
      {children}
    </button>
  )
}

/**
 * EmptyState - A consistent empty state for panels
 *
 * Supports lucide-animated icons via `animatedIcon`. These auto-play
 * their entrance animation on mount and loop every few seconds.
 */
interface EmptyStateProps {
  icon?: React.ReactNode
  /** A lucide-animated icon component. Will auto-play on mount and loop. Takes precedence over `icon`. */
  animatedIcon?: React.ForwardRefExoticComponent<React.RefAttributes<AnimatedIconHandle> & { size?: number }>
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

function AnimatedEmptyIcon({ Component }: { Component: React.ForwardRefExoticComponent<React.RefAttributes<AnimatedIconHandle> & { size?: number }> }) {
  const iconRef = React.useRef<AnimatedIconHandle>(null)

  React.useEffect(() => {
    if (!iconRef.current) return
    iconRef.current.startAnimation()
    const interval = setInterval(() => {
      iconRef.current?.startAnimation()
    }, 4000)
    return () => clearInterval(interval)
  }, [])

  return <Component ref={iconRef} size={24} />
}

export function EmptyState({ icon, animatedIcon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center h-full text-center px-6", className)}>
      {(animatedIcon || icon) && (
        <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4 text-muted-foreground">
          {animatedIcon ? <AnimatedEmptyIcon Component={animatedIcon} /> : icon}
        </div>
      )}
      <h3 className="font-semibold text-lg">{title}</h3>
      {description && (
        <p className="text-muted-foreground text-sm mt-1 max-w-xs">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
