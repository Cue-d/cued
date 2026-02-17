import {
  Inbox,
  MessageCircle,
  Users,
  Settings,
  Puzzle,
  Keyboard,
  LogOut,
  MessageSquare,
  PanelLeft,
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
} from '@cued/ui'
import { type ActionPlatform } from '@cued/shared'
import { type UserProfile } from './types'

export type NavPage = 'actions' | 'assistant' | 'contacts' | 'settings'

interface NavItem {
  id: NavPage
  title: string
  icon: LucideIcon
}

const NAV_ITEMS: NavItem[] = [
  { id: 'actions', title: 'Actions', icon: Inbox },
  { id: 'assistant', title: 'Assistant', icon: MessageCircle },
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
  /** Connected platforms for integrations UI */
  connectedPlatforms?: ActionPlatform[]
  /** Callback when an integration platform is clicked */
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
          className="no-drag absolute opacity-70 hover:opacity-100 transition-opacity top-2 right-2 flex items-center justify-center h-6 w-6 rounded-md hover:bg-foreground/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring z-50 cursor-pointer"
          title="Toggle sidebar (⌘B)"
        >
          <PanelLeft size={14} strokeWidth={2} />
        </button>
      )}

      {/* Primary Navigation - scrollable area */}
      <div className="flex-1 overflow-y-auto min-h-0 px-2 py-2">
        <nav className="grid gap-0.5" role="navigation" aria-label="Main navigation">
          {NAV_ITEMS.map((item) => {
            const isActive = currentPage === item.id
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
                    ? 'bg-foreground/10 font-medium text-foreground'
                    : 'text-foreground/70 hover:bg-foreground/5 hover:text-foreground'
                )}
              >
                <span className="h-3.5 w-3.5 shrink-0 flex items-center justify-center">
                  <item.icon size={14} strokeWidth={2} className={cn(isActive && "text-foreground")} />
                </span>
                    <span className="flex-1 text-left">{item.title}</span>
                    {badgeCount !== undefined && badgeCount > 0 && (
                      <Badge
                        variant="secondary"
                        className="h-5 min-w-[20px] px-1.5 text-[11px] font-medium"
                      >
                        {badgeCount > 99 ? '99+' : badgeCount}
                      </Badge>
                    )}
              </button>
            )
          })}
        </nav>
      </div>

      {/* Bottom Section: Profile */}
      <div className="mt-auto shrink-0 py-2 px-2">
        {/* Profile dropdown */}
        <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                'flex items-center gap-2 cursor-pointer flex-1 min-w-0 px-2 py-1.5 rounded-md',
                'text-foreground hover:bg-foreground/5',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              )}
            >
              <div className="h-5 w-5 rounded-full bg-foreground text-background text-[10px] font-medium flex items-center justify-center shrink-0 ring-1 ring-border/50">
                {userInitial}
              </div>
              <span className="text-sm truncate text-accent-foreground">{displayName}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" sideOffset={8} className="min-w-[180px]">
              <DropdownMenuItem onClick={() => onNavigate('settings')}>
                <Settings size={16} strokeWidth={1.75} />
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onNavigateToIntegrations}>
                <Puzzle size={16} strokeWidth={1.75} />
                Integrations
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onNavigateToShortcuts}>
                <Keyboard size={16} strokeWidth={1.75} />
                Shortcuts
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled>
                <MessageSquare size={16} strokeWidth={1.75} />
                Feedback
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onSignOut}>
                <LogOut size={16} strokeWidth={1.75} />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
