"use client"

import * as React from "react"
import { Clock, CalendarIcon } from "lucide-react"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"
import { Calendar } from "../ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/popover"
import { Input } from "../ui/input"

export interface SnoozePickerProps {
  /** Called when user selects a snooze time */
  onSelect: (timestamp: number) => void
  /** Optional callback when picker is closed without selection */
  onCancel?: () => void
  /** Optional custom class name */
  className?: string
}

/** Calculate next occurrence of a specific time */
function getNextTime(hour: number, minute: number = 0): Date {
  const now = new Date()
  const next = new Date(now)
  next.setHours(hour, minute, 0, 0)

  // If time has passed today, set for tomorrow
  if (next <= now) {
    next.setDate(next.getDate() + 1)
  }

  return next
}

/** Get next Monday at a specific time */
function getNextMonday(hour: number = 9): Date {
  const now = new Date()
  const dayOfWeek = now.getDay()
  const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek

  const monday = new Date(now)
  monday.setDate(monday.getDate() + daysUntilMonday)
  monday.setHours(hour, 0, 0, 0)

  return monday
}

/** Preset snooze options */
const PRESETS = [
  {
    label: "1 hour",
    getTime: () => new Date(Date.now() + 60 * 60 * 1000),
    icon: Clock,
  },
  {
    label: "3 hours",
    getTime: () => new Date(Date.now() + 3 * 60 * 60 * 1000),
    icon: Clock,
  },
  {
    label: "Tomorrow 9am",
    getTime: () => getNextTime(9),
    icon: CalendarIcon,
  },
  {
    label: "Next Monday 9am",
    getTime: () => getNextMonday(9),
    icon: CalendarIcon,
  },
] as const

/**
 * SnoozePicker component for action queue.
 * Provides preset snooze times and custom date/time selection.
 */
export function SnoozePicker({
  onSelect,
  onCancel,
  className,
}: SnoozePickerProps) {
  const [showCustom, setShowCustom] = React.useState(false)
  const [selectedDate, setSelectedDate] = React.useState<Date | undefined>()
  const [selectedTime, setSelectedTime] = React.useState("09:00")
  const [isCalendarOpen, setIsCalendarOpen] = React.useState(false)

  const handlePresetSelect = (getTime: () => Date) => {
    const time = getTime()
    onSelect(time.getTime())
  }

  const handleCustomConfirm = () => {
    if (!selectedDate) return

    const [hours, minutes] = selectedTime.split(":").map(Number)
    const dateTime = new Date(selectedDate)
    dateTime.setHours(hours, minutes, 0, 0)

    // Don't allow snoozing to the past
    if (dateTime <= new Date()) {
      return
    }

    onSelect(dateTime.getTime())
  }

  const formatSelectedDateTime = () => {
    if (!selectedDate) return "Select date & time"

    const [hours, minutes] = selectedTime.split(":").map(Number)
    const dateTime = new Date(selectedDate)
    dateTime.setHours(hours, minutes, 0, 0)

    return dateTime.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
  }

  if (showCustom) {
    return (
      <div
        className={cn(
          "flex flex-col gap-3 p-4 bg-card rounded-lg border shadow-lg",
          className
        )}
      >
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-sm">Custom snooze</h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowCustom(false)}
          >
            Back
          </Button>
        </div>

        <Popover open={isCalendarOpen} onOpenChange={setIsCalendarOpen}>
          <PopoverTrigger
            className={cn(
              "inline-flex items-center justify-start gap-2 whitespace-nowrap rounded-md text-sm font-medium",
              "ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              "disabled:pointer-events-none disabled:opacity-50",
              "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
              "h-10 px-4 py-2 w-full text-left",
              !selectedDate && "text-muted-foreground"
            )}
          >
            <CalendarIcon className="h-4 w-4" />
            {selectedDate
              ? selectedDate.toLocaleDateString("en-US", {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })
              : "Pick a date"}
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={selectedDate}
              onSelect={(date) => {
                setSelectedDate(date)
                setIsCalendarOpen(false)
              }}
              disabled={(date) => date < new Date(new Date().setHours(0, 0, 0, 0))}
            />
          </PopoverContent>
        </Popover>

        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <Input
            type="time"
            value={selectedTime}
            onChange={(e) => setSelectedTime(e.target.value)}
            className="flex-1"
          />
        </div>

        <div className="text-xs text-muted-foreground">
          {formatSelectedDateTime()}
        </div>

        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="flex-1"
            onClick={handleCustomConfirm}
            disabled={!selectedDate}
          >
            Snooze
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-2 p-4 bg-card rounded-lg border shadow-lg",
        className
      )}
    >
      <h3 className="font-medium text-sm text-muted-foreground mb-1">
        Snooze until
      </h3>

      {PRESETS.map((preset) => (
        <Button
          key={preset.label}
          variant="ghost"
          className="justify-start h-10 px-3"
          onClick={() => handlePresetSelect(preset.getTime)}
        >
          <preset.icon className="mr-3 h-4 w-4 text-muted-foreground" />
          {preset.label}
        </Button>
      ))}

      <div className="border-t my-1" />

      <Button
        variant="ghost"
        className="justify-start h-10 px-3"
        onClick={() => setShowCustom(true)}
      >
        <CalendarIcon className="mr-3 h-4 w-4 text-muted-foreground" />
        Custom...
      </Button>

      {onCancel && (
        <>
          <div className="border-t my-1" />
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </>
      )}
    </div>
  )
}

export default SnoozePicker
