import {
  Inbox,
  MessageSquare,
  Users,
  HelpCircle,
  PanelLeftClose,
  Settings,
  Puzzle,
  Keyboard,
  LogOut,
  MessageCircle,
  BookOpen,
  type LucideIcon,
} from 'lucide-react'
import {
  Badge,
  cn,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from '@cued/ui'
import { type ActionPlatform } from '@cued/shared'
import { IntegrationsMenu } from './IntegrationsMenu'
import { type UserProfile } from './types'

export type NavPage = 'actions' | 'assistant' | 'contacts' | 'settings'

interface NavItem {
  id: NavPage
  title: string
  icon: LucideIcon
}

const NAV_ITEMS: NavItem[] = [
  { id: 'actions', title: 'Actions', icon: Inbox },
  { id: 'assistant', title: 'Assistant', icon: MessageSquare },
  { id: 'contacts', title: 'Contacts', icon: Users },
]

interface LeftSidebarProps {
  currentPage: NavPage
  onNavigate: (page: NavPage) => void
  /** Navigate directly to shortcuts page */
  onNavigateToShortcuts?: () => void
  /** Navigate directly to integrations page */
  onNavigateToIntegrations?: () => void
  /** Sign out callback */
  onSignOut?: () => void
  actionCount?: number
  isCollapsed?: boolean
  /** User profile for bottom section */
  user?: UserProfile | null
  /** Callback to toggle sidebar visibility */
  onToggle?: () => void
  /** Connected platforms for integrations menu */
  connectedPlatforms?: ActionPlatform[]
  /** Callback when a platform is clicked in integrations menu */
  onPlatformClick?: (platform: ActionPlatform) => void
}

/**
 * LeftSidebar - Navigation sidebar matching Craft Agents design
 */
export function LeftSidebar({
  currentPage,
  onNavigate,
  onNavigateToShortcuts,
  onNavigateToIntegrations,
  onSignOut,
  actionCount,
  isCollapsed = false,
  user,
  onToggle,
  connectedPlatforms,
  onPlatformClick,
}: LeftSidebarProps) {
  const getBadgeCount = (id: NavPage): number | undefined => {
    switch (id) {
      case 'actions':
        return actionCount
      default:
        return undefined
    }
  }

  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(' ')
  const userInitial = user?.firstName?.charAt(0) || user?.email?.charAt(0) || 'U'
  const displayName = fullName || user?.email?.split('@')[0] || 'User'

  return (
    <div className="relative flex h-full flex-col pt-[50px] select-none">
      {/* Toggle button - positioned in title bar area, aligned with traffic lights */}
      {onToggle && (
        <button
          onClick={onToggle}
          className="no-drag absolute top-2 right-2 flex items-center justify-center h-6 w-6 rounded-[6px] text-foreground/60 hover:text-foreground hover:bg-foreground/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring z-50 cursor-pointer"
          title="Toggle sidebar (⌘B)"
        >
          <PanelLeftClose className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Primary Navigation - scrollable area */}
      <div className="flex-1 overflow-y-auto min-h-0 px-2 py-2">
        <nav className="grid gap-0.5" role="navigation" aria-label="Main navigation">
          {NAV_ITEMS.map((item) => {
            const isActive = currentPage === item.id
            const Icon = item.icon
            const badgeCount = getBadgeCount(item.id)

            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                className={cn(
                  'group flex w-full items-center gap-2 rounded-[6px] text-[13px] select-none outline-none cursor-pointer',
                  'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
                  'py-[5px] px-2',
                  isActive
                    ? 'bg-sidebar-accent/50'
                    : 'hover:bg-sidebar-accent/50'
                )}
              >
                <span className="h-3.5 w-3.5 shrink-0 flex items-center justify-center">
                  <Icon className="h-3.5 w-3.5" />
                </span>
                {!isCollapsed && (
                  <>
                    <span className="flex-1 text-left">{item.title}</span>
                    {badgeCount !== undefined && badgeCount > 0 && (
                      <Badge
                        variant="secondary"
                        className="h-5 min-w-[20px] px-1.5 text-[11px] font-medium"
                      >
                        {badgeCount > 99 ? '99+' : badgeCount}
                      </Badge>
                    )}
                  </>
                )}
              </button>
            )
          })}
        </nav>
      </div>

      {/* Integrations Menu - above bottom section */}
      {!isCollapsed && (
        <IntegrationsMenu
          connectedPlatforms={connectedPlatforms}
          onPlatformClick={onPlatformClick}
        />
      )}

      {/* Bottom Section: Profile + Help */}
      <div className="mt-auto shrink-0 py-2 px-2">
        <div className="flex items-center gap-1">
          {/* Profile dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                'flex items-center gap-2 cursor-pointer flex-1 min-w-0 px-2 py-1.5 rounded-md',
                'text-foreground hover:bg-foreground/5',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                isCollapsed && 'h-9 w-9 shrink-0 justify-center p-0'
              )}
            >
              <div className="h-5 w-5 rounded-full bg-foreground text-background text-[10px] font-medium flex items-center justify-center shrink-0 ring-1 ring-border/50">
                {userInitial}
              </div>
              <span className="text-sm truncate text-accent-foreground">{displayName}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" sideOffset={8} className="min-w-[180px]">
              <DropdownMenuItem onClick={() => onNavigate('settings')}>
                <Settings className="h-4 w-4" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onNavigateToIntegrations}>
                <Puzzle className="h-4 w-4" />
                Integrations
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onNavigateToShortcuts}>
                <Keyboard className="h-4 w-4" />
                Shortcuts
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onSignOut}>
                <LogOut className="h-4 w-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Help dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className="flex items-center justify-center h-7 w-7 rounded-[6px] select-none outline-none hover:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <HelpCircle className="h-4 w-4 text-foreground/60" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" sideOffset={8} className="min-w-[180px]">
              <DropdownMenuItem disabled>
                <MessageCircle className="h-4 w-4" />
                Feedback
                <DropdownMenuShortcut className="text-[10px] font-normal tracking-normal">Coming soon...</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem disabled>
                <BookOpen className="h-4 w-4" />
                Docs
                <DropdownMenuShortcut className="text-[10px] font-normal tracking-normal">Coming soon...</DropdownMenuShortcut>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  )
}
