import * as React from 'react'
import { cn } from '@cued/ui'

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
 * - Background color (theme-aware using foreground-2)
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
  // Rounded corner classes based on position in layout
  const roundedClasses = {
    first: 'rounded-l-[14px] rounded-r-[10px]',
    middle: 'rounded-[10px]',
    last: 'rounded-l-[10px] rounded-r-[14px]',
    only: 'rounded-[14px]',
  }

  return (
    <div
      className={cn(
        'h-full flex flex-col min-w-0 overflow-hidden bg-foreground-2 shadow-middle',
        roundedClasses[position],
        variant === 'grow' && 'flex-1',
        variant === 'shrink' && 'shrink-0',
        className
      )}
      style={{
        ...(variant === 'shrink' && width ? { width } : {}),
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
  children?: React.ReactNode
  className?: string
  /** Adds left padding to compensate for macOS stoplight controls */
  compensateForStoplight?: boolean
}

export function PanelHeader({
  title,
  subtitle,
  children,
  className,
  compensateForStoplight = false,
}: PanelHeaderProps) {
  return (
    <div
      className={cn(
        'drag-region flex items-center h-10 px-4 shrink-0 relative z-50 gap-1',
        compensateForStoplight && 'pl-20',
        className
      )}
    >
      <div className="flex-1 min-w-0 flex items-center justify-center select-none gap-2">
        {title && (
          <h2 className="text-sm font-semibold truncate leading-tight">
            {title}
          </h2>
        )}
        {subtitle && (
          <span className="text-xs text-muted-foreground">{subtitle}</span>
        )}
      </div>

      {children && (
        <div className="no-drag shrink-0 flex items-center gap-2">
          {children}
        </div>
      )}
    </div>
  )
}
