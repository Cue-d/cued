import { PLATFORM_CONFIG, type ActionPlatform } from '@cued/shared'
import { cn, PLATFORM_ICON_COMPONENTS, GmailColorIcon } from '@cued/ui'

/** Platforms to display in order */
const DISPLAY_PLATFORMS: ActionPlatform[] = [
  'imessage',
  'gmail',
  'slack',
  'linkedin',
  'twitter',
  'signal',
]

interface IntegrationsMenuProps {
  /** Connected platforms (will show as active) */
  connectedPlatforms?: ActionPlatform[]
  /** Callback when a platform icon is clicked */
  onPlatformClick?: (platform: ActionPlatform) => void
}

/**
 * IntegrationsMenu - Shows connected platform icons in the sidebar
 * Always visible to encourage connecting accounts
 */
export function IntegrationsMenu({
  connectedPlatforms = [],
  onPlatformClick,
}: IntegrationsMenuProps) {
  return (
    <div className="mx-2 mb-2 rounded-lg bg-foreground/6 border border-foreground/8 overflow-hidden">
      {/* Header */}
      <div className="flex items-center px-2.5 py-2">
        <span className="text-xs font-medium text-foreground/70">
          Connected accounts
        </span>
      </div>

      {/* Platform icons */}
      <div className="flex items-center gap-0.5 px-2 pb-2.5 pt-0.5 flex-wrap">
        {DISPLAY_PLATFORMS.map((platform) => {
          const Icon = platform === 'gmail' ? GmailColorIcon : PLATFORM_ICON_COMPONENTS[platform]
          const config = PLATFORM_CONFIG[platform]
          const isConnected = connectedPlatforms.includes(platform)

          return (
            <button
              key={platform}
              onClick={() => onPlatformClick?.(platform)}
              className={cn(
                'relative group flex cursor-pointer items-center justify-center w-7 h-7 rounded-md transition-all duration-150',
                'hover:scale-110 hover:z-10 hover:shadow-lg hover:shadow-black/20',
                isConnected
                  ? 'bg-foreground/10'
                  : 'bg-foreground/4 hover:bg-foreground/10'
              )}
              title={config.label}
              style={{
                // Use platform color for connected state
                ...(isConnected && {
                  backgroundColor: `${config.color}20`,
                }),
              }}
            >
              <Icon
                className={cn(
                  'w-3.5 h-3.5 transition-colors',
                  isConnected ? config.textClass : 'text-foreground/60 group-hover:text-foreground/80'
                )}
              />
              {/* Connected indicator dot */}
              {isConnected && (
                <span
                  className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-background"
                  style={{ backgroundColor: config.color }}
                />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
