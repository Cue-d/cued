import { getActionTypesByCategory } from "@cued/shared"

// Derive filter groups from the action registry
const messageTypes = getActionTypesByCategory("message")
const contactTypes = getActionTypesByCategory("contact")

/** Filter group definitions - derived from action registry */
export const ACTION_FILTER_GROUPS = {
  all: {
    label: "All",
    types: null, // null means no filter
  },
  messages: {
    label: "Messages",
    types: messageTypes.filter((t) => t === "respond" || t === "send_message"),
  },
  contacts: {
    label: "Contacts",
    types: contactTypes.filter((t) => t === "resolve_contact" || t === "new_connection"),
  },
  followups: {
    label: "Follow-ups",
    types: [...messageTypes, ...contactTypes].filter(
      (t) => t === "follow_up" || t === "eod_contact"
    ),
  },
} as const

export type FilterGroup = keyof typeof ACTION_FILTER_GROUPS

/** Calculate count for a filter group */
export function getGroupCount(
  group: FilterGroup,
  counts: Record<string, number>,
  total: number
): number {
  const config = ACTION_FILTER_GROUPS[group]
  if (config.types === null) {
    return total
  }
  return config.types.reduce((sum, type) => sum + (counts[type] ?? 0), 0)
}
