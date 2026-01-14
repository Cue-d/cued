import type { ComponentProps, HTMLAttributes, KeyboardEventHandler } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

export type PromptInputProps = HTMLAttributes<HTMLFormElement>

export const PromptInput = ({ className, ...props }: PromptInputProps) => (
  <form
    className={cn('w-full overflow-hidden rounded-xl border bg-background shadow-xs', className)}
    {...props}
  />
)

export type PromptInputTextareaProps = ComponentProps<typeof Textarea> & {
  minHeight?: number
  maxHeight?: number
  disableAutoResize?: boolean
}

export const PromptInputTextarea = ({
  onChange,
  className,
  placeholder = 'iMessage',
  minHeight = 36,
  maxHeight = 164,
  disableAutoResize = false,
  ...props
}: PromptInputTextareaProps) => {
  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    if (e.key === 'Enter') {
      // Don't submit if IME composition is in progress
      if (e.nativeEvent.isComposing) {
        return
      }

      if (e.shiftKey) {
        // Allow newline
        return
      }

      // Submit on Enter (without Shift)
      e.preventDefault()
      const form = e.currentTarget.form
      if (form) {
        form.requestSubmit()
      }
    }
  }

  return (
    <Textarea
      className={cn(
        'w-full resize-none rounded-none border-none p-3 shadow-none outline-hidden ring-0',
        disableAutoResize ? 'field-sizing-fixed' : 'field-sizing-content max-h-[6lh]',
        'bg-transparent dark:bg-transparent',
        'focus-visible:ring-0',
        className
      )}
      name="message"
      onChange={(e) => {
        onChange?.(e)
      }}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      style={{ minHeight, maxHeight }}
      {...props}
    />
  )
}

export type PromptInputToolbarProps = HTMLAttributes<HTMLDivElement>

export const PromptInputToolbar = ({ className, ...props }: PromptInputToolbarProps) => (
  <div className={cn('flex items-center justify-between p-1', className)} {...props} />
)

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>

export const PromptInputTools = ({ className, ...props }: PromptInputToolsProps) => (
  <div
    className={cn('flex items-center gap-1', '[&_button:first-child]:rounded-bl-xl', className)}
    {...props}
  />
)

export type PromptInputSubmitProps = ComponentProps<typeof Button> & {
  isLoading?: boolean
}

export const PromptInputSubmit = ({
  className,
  variant = 'default',
  size = 'icon',
  isLoading,
  children,
  ...props
}: PromptInputSubmitProps) => {
  return (
    <Button
      className={cn('gap-1.5 rounded-lg', className)}
      size={size}
      variant={variant}
      {...props}
      disabled={isLoading}
    >
      {children}
    </Button>
  )
}
