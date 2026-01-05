import type { SwipeDirection } from '../data/types'

// Re-export types from data/types for consumers that import from api/actions
export type { ActionResponse, SearchResultResponse, SwipeRequest } from '../data/types'

export async function fetchActions(status = 'pending', limit = 50) {
  return window.api.getActions(status, limit)
}

export async function swipeAction(
  actionId: number,
  direction: SwipeDirection,
  responseText?: string,
  snoozeMinutes?: number
) {
  return window.api.swipeAction(actionId, {
    direction,
    response_text: responseText,
    snooze_minutes: snoozeMinutes
  })
}

export async function searchMessages(query: string, limit = 50) {
  return window.api.searchMessages(query, limit)
}

export async function semanticSearch(query: string, limit = 20) {
  return window.api.semanticSearch(query, limit)
}

export async function addContactContext(personId: number, notes: string) {
  return window.api.addContactContext(personId, notes)
}
