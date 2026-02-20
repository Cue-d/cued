import * as React from 'react'
import { cn } from '@cued/ui'

const OUTER_RADIUS = 10
const INNER_RADIUS = 8

export interface PanelProps {
  /** Panel sizing behavior */
  variant?: 'shrink' | 'grow'
  /** Fixed width in pixels (only for shrink variant) */
  width?: number
  /** Position in the layout for proper rounded corners */
  position?: 'first' | 'middle' | 'last' | 'only'
  /** Optional className for additional styling */
  className?: string
  /** Optional inline styles */
  style?: React.CSSProperties
  /** Panel content */
  children: React.ReactNode
}

/**
 * Panel - Base container component for app panels
 * Provides consistent styling for panel containers including:
 * - Background color
 * - Overflow handling
 * - Shadow and rounded corners matching Craft Agents design
 */
export function Panel({
  variant = 'grow',
  width,
  position = 'only',
  className,
  style,
  children,
}: PanelProps) {
  const radiusStyle: React.CSSProperties = {
    first: {
      borderTopLeftRadius: OUTER_RADIUS,
      borderBottomLeftRadius: OUTER_RADIUS,
      borderTopRightRadius: INNER_RADIUS,
      borderBottomRightRadius: INNER_RADIUS,
    },
    middle: { borderRadius: INNER_RADIUS },
    last: {
      borderTopLeftRadius: INNER_RADIUS,
      borderBottomLeftRadius: INNER_RADIUS,
      borderTopRightRadius: OUTER_RADIUS,
      borderBottomRightRadius: OUTER_RADIUS,
    },
    only: { borderRadius: OUTER_RADIUS },
  }[position]
  const shrinkWidthStyle: React.CSSProperties =
    variant === 'shrink' && width
      ? {
          width: position === 'first'
            ? `var(--cued-left-panel-width, ${width}px)`
            : width,
        }
      : {}

  return (
    <div
      className={cn(
        'h-full flex flex-col min-w-0 overflow-hidden shadow-middle',
        position === 'last' ? 'bg-background/60' : 'bg-background',
        variant === 'grow' && 'flex-1',
        variant === 'shrink' && 'shrink-0',
        className
      )}
      style={{
        ...radiusStyle,
        ...shrinkWidthStyle,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/** PanelHeader - Centered title with right-aligned action buttons */
interface PanelHeaderProps {
  title?: string
  subtitle?: string
  /** Custom content rendered in the centered title area instead of `title`/`subtitle` */
  titleContent?: React.ReactNode
  children?: React.ReactNode
  className?: string
  /** Adds left padding to compensate for macOS stoplight controls */
  compensateForStoplight?: boolean
  /** Deprecated no-op; retained for compatibility */
  scrolled?: boolean
}

export function PanelHeader(props: PanelHeaderProps) {
  const {
    title,
    subtitle,
    titleContent,
    children,
    className,
    compensateForStoplight = false,
  } = props

  return (
    <div
      className={cn(
        'drag-region flex items-center h-10 px-4 shrink-0 relative z-10 gap-1',
        compensateForStoplight && 'pl-20',
        className
      )}
    >
      <div className="flex-1 min-w-0 flex items-center justify-center select-none gap-2">
        {titleContent ?? (
          <>
            {title && (
              <h2 className="text-sm font-semibold truncate leading-tight">
                {title}
              </h2>
            )}
            {subtitle && (
              <span className="text-xs text-muted-foreground">{subtitle}</span>
            )}
          </>
        )}
      </div>

      {children && (
        <div className="no-drag absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-2">
          {children}
        </div>
      )}
    </div>
  )
}
