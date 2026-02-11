import * as React from "react"
import { cn } from "@cued/ui"

interface SettingsSectionProps {
  title: string
  description?: React.ReactNode
  children: React.ReactNode
  className?: string
}

export function SettingsSection({ title, description, children, className }: SettingsSectionProps) {
  return (
    <section className={cn("space-y-3", className)}>
      <div className="flex items-start justify-between gap-4 pl-1">
        <div className="space-y-0.5">
          <h3 className="text-base font-semibold">{title}</h3>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      {children}
    </section>
  )
}

interface SettingsCardProps {
  children: React.ReactNode
  className?: string
  divided?: boolean
}

export function SettingsCard({ children, className, divided = true }: SettingsCardProps) {
  const childArray = React.Children.toArray(children).filter(Boolean)

  return (
    <div className={cn("rounded-xl bg-background shadow-minimal overflow-hidden", className)}>
      {divided && childArray.length > 1
        ? childArray.map((child, index) => (
            <React.Fragment key={index}>
              {index > 0 && <div className="h-px bg-border/50 mx-4" />}
              {child}
            </React.Fragment>
          ))
        : children}
    </div>
  )
}

interface SettingsRowProps {
  label: string
  description?: string
  children?: React.ReactNode
  action?: React.ReactNode
  className?: string
}

export function SettingsRow({ label, description, children, action, className }: SettingsRowProps) {
  return (
    <div className={cn("w-full flex items-center justify-between text-left px-4 py-3.5", className)}>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {description && (
          <div className="text-sm text-muted-foreground mt-0 truncate">{description}</div>
        )}
      </div>
      {(children || action) && (
        <div className="flex items-center gap-3 ml-4 shrink-0">
          {children}
          {action}
        </div>
      )}
    </div>
  )
}
