import * as React from "react"
import { Send } from "lucide-react"
import { PLATFORM_CONFIG, type ActionPlatform } from "@prm/shared"
import { cn } from "../lib/utils"
import { Button } from "./ui/button"
import { Textarea } from "./ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select"

/** Contact with available platforms for sending */
export interface SendMessageContact {
  /** Contact ID (e.g., Convex ID) */
  id: string
  /** Display name */
  name: string
  /** Available platforms with their handles */
  platforms: Array<{
    platform: ActionPlatform
    handle: string
    /** Optional display label (e.g., "Work", "Personal") */
    label?: string
  }>
}

export interface SendMessageModalProps {
  /** Whether the modal is open */
  open: boolean
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void
  /** Pre-selected contact (optional) */
  contact?: SendMessageContact
  /** Pre-selected platform (optional) */
  defaultPlatform?: ActionPlatform
  /** Pre-filled message text (optional) */
  defaultMessage?: string
  /** Conversation ID to associate with the message (optional) */
  conversationId?: string
  /** Called when user sends the message */
  onSend: (params: {
    platform: ActionPlatform
    recipientHandle: string
    recipientContactId?: string
    text: string
    conversationId?: string
  }) => Promise<{ messageId: string; scheduledFor: number } | void>
  /** Additional class names */
  className?: string
}

/**
 * SendMessageModal - A dialog for composing and sending messages across platforms.
 *
 * Features:
 * - Contact selector (when no contact pre-selected)
 * - Platform indicator/selector for multi-platform contacts
 * - Message composer textarea
 * - Send button that calls queueMessage mutation
 *
 * @example
 * ```tsx
 * <SendMessageModal
 *   open={isOpen}
 *   onOpenChange={setIsOpen}
 *   contact={{
 *     id: "contact_123",
 *     name: "John Doe",
 *     platforms: [
 *       { platform: "imessage", handle: "+1234567890" },
 *       { platform: "linkedin", handle: "johndoe" },
 *     ],
 *   }}
 *   onSend={async (params) => {
 *     return await queueMessage(params)
 *   }}
 * />
 * ```
 */
export function SendMessageModal({
  open,
  onOpenChange,
  contact,
  defaultPlatform,
  defaultMessage = "",
  conversationId,
  onSend,
  className,
}: SendMessageModalProps) {
  // Form state
  const [selectedPlatform, setSelectedPlatform] = React.useState<ActionPlatform | null>(
    defaultPlatform ?? contact?.platforms[0]?.platform ?? null
  )
  const [message, setMessage] = React.useState(defaultMessage)
  const [isSending, setIsSending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Reset form when modal opens/closes or contact changes
  React.useEffect(() => {
    if (open) {
      setSelectedPlatform(defaultPlatform ?? contact?.platforms[0]?.platform ?? null)
      setMessage(defaultMessage)
      setError(null)
    }
  }, [open, contact, defaultPlatform, defaultMessage])

  // Get available platforms from contact
  const availablePlatforms = contact?.platforms ?? []
  const selectedPlatformInfo = availablePlatforms.find(
    (p) => p.platform === selectedPlatform
  )

  // Can send if we have a platform, handle, and message
  const canSend =
    selectedPlatform &&
    selectedPlatformInfo &&
    message.trim().length > 0 &&
    !isSending

  const handleSend = async () => {
    if (!canSend || !selectedPlatform || !selectedPlatformInfo) return

    setIsSending(true)
    setError(null)

    try {
      await onSend({
        platform: selectedPlatform,
        recipientHandle: selectedPlatformInfo.handle,
        recipientContactId: contact?.id,
        text: message.trim(),
        conversationId,
      })

      // Close modal on success
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message")
    } finally {
      setIsSending(false)
    }
  }

  // Handle keyboard shortcut (Cmd/Ctrl + Enter to send)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault()
      handleSend()
    }
  }

  const platformConfig = selectedPlatform ? PLATFORM_CONFIG[selectedPlatform] : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("sm:max-w-md", className)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {contact ? (
              <>
                Send message to {contact.name}
              </>
            ) : (
              "Send message"
            )}
          </DialogTitle>
          {contact && availablePlatforms.length > 1 && (
            <DialogDescription>
              Choose a platform and compose your message
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="grid gap-4">
          {/* Platform selector - show if contact has multiple platforms */}
          {availablePlatforms.length > 1 && (
            <div className="space-y-2">
              <label className="text-sm font-medium leading-none">Platform</label>
              <Select
                value={selectedPlatform ?? undefined}
                onValueChange={(value) => setSelectedPlatform(value as ActionPlatform)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {platformConfig ? (
                      <span className="flex items-center gap-2">
                        <span
                          className={cn(
                            "flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium",
                            platformConfig.bgClass
                          )}
                        >
                          {platformConfig.letter}
                        </span>
                        <span>{platformConfig.label}</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Select platform</span>
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {availablePlatforms.map((p) => {
                    const config = PLATFORM_CONFIG[p.platform]
                    return (
                      <SelectItem key={p.platform} value={p.platform}>
                        <span className="flex items-center gap-2">
                          <span
                            className={cn(
                              "flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium",
                              config.bgClass
                            )}
                          >
                            {config.letter}
                          </span>
                          <span>{config.label}</span>
                          {p.label && (
                            <span className="text-muted-foreground">({p.label})</span>
                          )}
                        </span>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Single platform indicator */}
          {availablePlatforms.length === 1 && platformConfig && (
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium",
                  platformConfig.bgClass
                )}
              >
                {platformConfig.letter}
              </span>
              <span className="text-sm text-muted-foreground">
                via {platformConfig.label}
                {selectedPlatformInfo?.label && ` (${selectedPlatformInfo.label})`}
              </span>
            </div>
          )}

          {/* Message composer */}
          <div className="space-y-2">
            <label className="text-sm font-medium leading-none">Message</label>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your message..."
              className="min-h-[120px] max-h-[300px] resize-none"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Press {typeof navigator !== "undefined" && navigator.platform?.toLowerCase().includes("mac") ? "⌘" : "Ctrl"}+Enter to send
            </p>
          </div>

          {/* Error display */}
          {error && (
            <div className="text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSend}
            disabled={!canSend}
            className="gap-2"
          >
            {isSending ? (
              "Sending..."
            ) : (
              <>
                <Send className="w-4 h-4" />
                Send
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default SendMessageModal
