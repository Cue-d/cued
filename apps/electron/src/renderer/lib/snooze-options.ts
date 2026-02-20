const HOUR_MS = 60 * 60 * 1000

export interface SnoozeOption {
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

export const SNOOZE_OPTIONS: readonly SnoozeOption[] = [
  { label: "1 hour", getTime: () => Date.now() + HOUR_MS },
  { label: "3 hours", getTime: () => Date.now() + 3 * HOUR_MS },
  { label: "Tomorrow 9am", getTime: () => getNextMorning(1) },
  { label: "Next Monday 9am", getTime: getNextMonday9am },
]
