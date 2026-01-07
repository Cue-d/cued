import type { SwipeDirection } from '../data/types'
import {
  fetchActions as clientFetchActions,
  swipeAction as clientSwipeAction,
  searchMessages as clientSearchMessages,
  addContactContext as clientAddContactContext
} from './client'

// Re-export types for consumers that import from api/actions
export type { ActionResponse, SearchResultResponse, SwipeRequest } from '../data/types'
export type { AttachmentResponse } from './client'

export async function fetchActions(status = 'pending', limit = 50, actionType?: string) {
  return clientFetchActions(status, limit, actionType)
}

export async function swipeAction(
  actionId: number,
  direction: SwipeDirection,
  responseText?: string,
  snoozeMinutes?: number
) {
  return clientSwipeAction(actionId, {
    direction,
    response_text: responseText,
    snooze_minutes: snoozeMinutes
  })
}

export async function searchMessages(query: string, limit = 50) {
  return clientSearchMessages(query, limit)
}

export async function addContactContext(personId: number, notes: string) {
  return clientAddContactContext(personId, notes)
}
