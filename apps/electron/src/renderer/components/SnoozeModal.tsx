import { Clock } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@cued/ui"
import { SNOOZE_OPTIONS, type SnoozeOption } from "../lib/snooze-options"

interface SnoozeModalProps {
  open: boolean
  onClose: () => void
  onSnooze: (snoozedUntil: number) => void
}

export function SnoozeModal({ open, onClose, onSnooze }: SnoozeModalProps): React.ReactElement {
  function handleSelect(option: SnoozeOption): void {
    onSnooze(option.getTime())
    onClose()
  }

  function handleOpenChange(isOpen: boolean): void {
    if (!isOpen) onClose()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="w-5 h-5" />
            Snooze until
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-2 py-2">
          {SNOOZE_OPTIONS.map((option) => (
            <button
              key={option.label}
              type="button"
              onClick={() => handleSelect(option)}
              className="w-full text-left px-4 py-3 rounded-lg hover:bg-muted transition-colors text-sm font-medium"
            >
              {option.label}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
