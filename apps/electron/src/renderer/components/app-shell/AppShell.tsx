import * as React from 'react'
import { motion } from 'motion/react'
import { cn } from '@cued/ui'
import { type ActionPlatform } from '@cued/shared'
import { LeftSidebar, type NavPage } from './LeftSidebar'
import { type UserProfile } from './types'
import { useGlobalShortcuts } from '../../hooks/keyboard'
import { useFocusContext } from '../../context/FocusContext'

// Layout constants
const PANEL_SPACING = 5
const PANEL_EDGE_SPACING = 6
const DEFAULT_SIDEBAR_WIDTH = 200
const MIN_SIDEBAR_WIDTH = 180
const MAX_SIDEBAR_WIDTH = 320
const DEFAULT_LEFT_PANEL_WIDTH = 320
const MIN_LEFT_PANEL_WIDTH = 240
const MAX_LEFT_PANEL_WIDTH = 480

// Spring transition for smooth animations
const SPRING_TRANSITION = {
  type: 'spring' as const,
  stiffness: 500,
  damping: 40,
  mass: 1,
}

interface AppShellProps {
  /** Current active page */
  currentPage: NavPage
  /** Navigation handler */
  onNavigate: (page: NavPage) => void
  /** Navigate directly to shortcuts page */
  onNavigateToShortcuts?: () => void
  /** Navigate directly to integrations page */
  onNavigateToIntegrations?: () => void
  /** Sign out callback */
  onSignOut?: () => void
  /** Action count for badge */
  actionCount?: number
  /** Page content - renders inside the main content area */
  children?: React.ReactNode
  /** Whether the sidebar is visible (controlled) */
  isSidebarVisible?: boolean
  /** Callback when sidebar visibility changes */
  onSidebarVisibilityChange?: (visible: boolean) => void
  /** User profile for sidebar */
  user?: UserProfile | null
  /** Connected platforms for integrations menu */
  connectedPlatforms?: ActionPlatform[]
  /** Callback when a platform is clicked in integrations menu */
  onPlatformClick?: (platform: ActionPlatform) => void
}

/**
 * AppShell - Main 3-panel layout container matching Craft Agents design
 *
 * Layout: [LeftSidebar] | [ListPanel] | [DetailPanel]
 */
export function AppShell({
  currentPage,
  onNavigate,
  onNavigateToShortcuts,
  onNavigateToIntegrations,
  onSignOut,
  actionCount,
  children,
  isSidebarVisible: controlledSidebarVisible,
  onSidebarVisibilityChange,
  user,
  connectedPlatforms,
  onPlatformClick,
}: AppShellProps) {
  const { focusZone, focusNextZone, focusPreviousZone } = useFocusContext()

  // Internal sidebar visibility state (uncontrolled by default)
  const [internalSidebarVisible, setInternalSidebarVisible] = React.useState(true)
  const isSidebarVisible = controlledSidebarVisible ?? internalSidebarVisible

  const toggleSidebar = React.useCallback(() => {
    const newValue = !isSidebarVisible
    setInternalSidebarVisible(newValue)
    onSidebarVisibilityChange?.(newValue)
  }, [isSidebarVisible, onSidebarVisibilityChange])

  const [sidebarWidth, setSidebarWidth] = React.useState(() => {
    const stored = localStorage.getItem('cued-sidebar-width')
    if (stored) {
      const width = parseInt(stored, 10)
      if (!isNaN(width) && width >= MIN_SIDEBAR_WIDTH && width <= MAX_SIDEBAR_WIDTH) {
        return width
      }
    }
    return DEFAULT_SIDEBAR_WIDTH
  })
  const [leftPanelWidth, setLeftPanelWidth] = React.useState(() => {
    const stored = localStorage.getItem('cued-left-panel-width')
    if (stored) {
      const width = parseInt(stored, 10)
      if (!isNaN(width) && width >= MIN_LEFT_PANEL_WIDTH && width <= MAX_LEFT_PANEL_WIDTH) {
        return width
      }
    }
    return DEFAULT_LEFT_PANEL_WIDTH
  })
  const [isResizing, setIsResizing] = React.useState<'sidebar' | 'left-panel' | null>(null)
  const [isSidebarResizeHovered, setIsSidebarResizeHovered] = React.useState(false)
  const [isLeftPanelResizeHovered, setIsLeftPanelResizeHovered] = React.useState(false)
  const mainContentRef = React.useRef<HTMLDivElement>(null)
  const hasLeftPanelResize = currentPage === 'actions'
    || currentPage === 'assistant'
    || currentPage === 'contacts'
    || currentPage === 'settings'

  // Global keyboard shortcuts
  useGlobalShortcuts({
    shortcuts: [
      // Page navigation (Cmd+1/2/3/4)
      { key: '1', cmd: true, action: () => { onNavigate('actions'); focusZone('list') } },
      { key: '2', cmd: true, action: () => { onNavigate('assistant'); focusZone('detail') } },
      { key: '3', cmd: true, action: () => { onNavigate('contacts'); focusZone('list') } },
      { key: '4', cmd: true, action: () => { onNavigate('settings'); focusZone('list') } },
      // Settings shortcuts
      { key: ',', cmd: true, action: () => onNavigate('settings') },
      { key: '/', cmd: true, action: () => onNavigateToShortcuts?.() },
      // Sidebar toggle
      { key: 'b', cmd: true, action: toggleSidebar },
      // Zone navigation
      { key: 'Tab', action: focusNextZone },
      { key: 'Tab', shift: true, action: focusPreviousZone },
    ],
  })

  // Persist sidebar width
  React.useEffect(() => {
    localStorage.setItem('cued-sidebar-width', String(sidebarWidth))
  }, [sidebarWidth])
  React.useEffect(() => {
    localStorage.setItem('cued-left-panel-width', String(leftPanelWidth))
  }, [leftPanelWidth])

  // Handle sidebar + left panel resize
  React.useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      if (isResizing === 'sidebar') {
        const newWidth = Math.max(
          MIN_SIDEBAR_WIDTH,
          Math.min(MAX_SIDEBAR_WIDTH, e.clientX)
        )
        setSidebarWidth(newWidth)
        return
      }

      const mainRect = mainContentRef.current?.getBoundingClientRect()
      if (!mainRect) return

      const panelStartX = mainRect.left + PANEL_EDGE_SPACING
      const newWidth = Math.max(
        MIN_LEFT_PANEL_WIDTH,
        Math.min(MAX_LEFT_PANEL_WIDTH, e.clientX - panelStartX)
      )
      setLeftPanelWidth(newWidth)
    }

    const handleMouseUp = () => {
      setIsResizing(null)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [hasLeftPanelResize, isResizing])

  return (
    <div className="h-full flex items-stretch relative bg-background/65">
      {/* Left Sidebar */}
      <motion.div
        initial={false}
        animate={{ width: isSidebarVisible ? sidebarWidth : 0 }}
        transition={isResizing === 'sidebar' ? { duration: 0 } : SPRING_TRANSITION}
        className="h-full overflow-hidden shrink-0 relative"
      >
        <div style={{ width: sidebarWidth }} className="h-full font-sans relative">
            <LeftSidebar
              currentPage={currentPage}
              onNavigate={onNavigate}
              onNavigateToShortcuts={onNavigateToShortcuts}
              onNavigateToIntegrations={onNavigateToIntegrations}
              onSignOut={onSignOut}
              actionCount={actionCount}
              isCollapsed={!isSidebarVisible}
              user={user}
              onToggle={toggleSidebar}
              connectedPlatforms={connectedPlatforms}
              onPlatformClick={onPlatformClick}
            />
        </div>
      </motion.div>

      {/* Sidebar Resize Handle */}
      <div
        onMouseDown={(e) => {
          e.preventDefault()
          setIsResizing('sidebar')
        }}
        onMouseEnter={() => setIsSidebarResizeHovered(true)}
        onMouseLeave={() => {
          if (isResizing !== 'sidebar') setIsSidebarResizeHovered(false)
        }}
        className="absolute top-0 w-3 h-full cursor-col-resize z-50 flex justify-center"
        style={{
          left: isSidebarVisible ? sidebarWidth - 6 : -6,
          transition: isResizing === 'sidebar' ? undefined : 'left 0.15s ease-out',
        }}
      >
        <div
          className={cn(
            'w-0.5 h-full transition-colors',
            isResizing === 'sidebar' || isSidebarResizeHovered ? 'bg-foreground/20' : 'bg-transparent'
          )}
        />
      </div>

      {/* Main Content Area */}
      <div
        ref={mainContentRef}
        className="flex-1 overflow-hidden min-w-0 flex h-full relative"
        style={{
          padding: PANEL_EDGE_SPACING,
          gap: PANEL_SPACING,
          ['--cued-left-panel-width' as string]: `${leftPanelWidth}px`,
        }}
      >
        {children}
        {hasLeftPanelResize && (
          <div
            onMouseDown={(e) => {
              e.preventDefault()
              setIsResizing('left-panel')
            }}
            onMouseEnter={() => setIsLeftPanelResizeHovered(true)}
            onMouseLeave={() => {
              if (isResizing !== 'left-panel') setIsLeftPanelResizeHovered(false)
            }}
            className="absolute top-0 w-3 h-full cursor-col-resize z-50 flex justify-center"
            style={{
              left: PANEL_EDGE_SPACING + leftPanelWidth - 6,
            }}
          >
            <div
              className={cn(
                'w-0.5 h-full transition-colors',
                isResizing === 'left-panel' || isLeftPanelResizeHovered ? 'bg-foreground/20' : 'bg-transparent'
              )}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export { type NavPage }
