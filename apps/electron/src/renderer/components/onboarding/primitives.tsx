import { cn, Button } from "@cued/ui"

// =============================================================================
// STEP ICON
// =============================================================================

export type StepIconVariant = "primary" | "success"

interface StepIconProps {
  children: React.ReactNode
  variant?: StepIconVariant
  className?: string
}

const iconVariantStyles: Record<StepIconVariant, string> = {
  primary: "text-foreground",
  success: "text-green-500",
}

export function StepIcon({ children, variant = "primary", className }: StepIconProps) {
  return (
    <div className={cn("mb-6 flex size-16 items-center justify-center", className)}>
      <div className={cn("size-8 [&>svg]:size-full", iconVariantStyles[variant])}>
        {children}
      </div>
    </div>
  )
}

// =============================================================================
// STEP HEADER
// =============================================================================

interface StepHeaderProps {
  title: string
  description?: React.ReactNode
  className?: string
}

export function StepHeader({ title, description, className }: StepHeaderProps) {
  return (
    <div className={cn("text-center", className)}>
      <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
      {description && (
        <p className="mt-2 text-sm max-w-sm text-muted-foreground">{description}</p>
      )}
    </div>
  )
}

// =============================================================================
// STEP FORM LAYOUT
// =============================================================================

interface StepFormLayoutProps {
  icon?: React.ReactNode
  iconVariant?: StepIconVariant
  title: string
  description?: React.ReactNode
  actions?: React.ReactNode
  children?: React.ReactNode
  className?: string
}

export function StepFormLayout({
  icon,
  iconVariant = "primary",
  title,
  description,
  actions,
  children,
  className,
}: StepFormLayoutProps) {
  return (
    <div className={cn("flex w-[28rem] flex-col items-center", className)}>
      {icon && (
        <StepIcon variant={iconVariant}>
          {icon}
        </StepIcon>
      )}

      <StepHeader title={title} description={description} />

      {children && <div className="mt-6 w-full">{children}</div>}

      {actions && (
        <div className="mt-8 flex w-full justify-center gap-3">
          {actions}
        </div>
      )}
    </div>
  )
}

// =============================================================================
// BUTTON HELPERS
// =============================================================================

interface ContinueButtonProps extends Omit<React.ComponentProps<typeof Button>, "children"> {
  children?: React.ReactNode
}

export function ContinueButton({
  children = "Continue",
  className,
  ...props
}: ContinueButtonProps) {
  return (
    <Button
      className={cn("flex-1 max-w-[320px]", className)}
      {...props}
    >
      {children}
    </Button>
  )
}
