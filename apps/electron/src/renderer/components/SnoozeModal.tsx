import { Clock } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@cued/ui"

const HOUR_MS = 60 * 60 * 1000

interface SnoozeOption {
  label: string
  getTime: () => number
}

function getNextMorning(daysFromNow: number): number {
  const date = new Date()
  date.setDate(date.getDate() + daysFromNow)
  date.setHours(9, 0, 0, 0)
  return date.getTime()
}

function getNextMonday9am(): number {
  const date = new Date()
  const daysUntilMonday = ((8 - date.getDay()) % 7) || 7
  date.setDate(date.getDate() + daysUntilMonday)
  date.setHours(9, 0, 0, 0)
  return date.getTime()
}

const SNOOZE_OPTIONS: SnoozeOption[] = [
  { label: "1 hour", getTime: () => Date.now() + HOUR_MS },
  { label: "3 hours", getTime: () => Date.now() + 3 * HOUR_MS },
  { label: "Tomorrow 9am", getTime: () => getNextMorning(1) },
  { label: "Next Monday 9am", getTime: getNextMonday9am },
]

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
