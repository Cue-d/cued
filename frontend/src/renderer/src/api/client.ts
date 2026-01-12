import type {
  ChatResponse,
  MessageResponse,
  SendMessageResponse,
  SyncStatusResponse,
  ActionResponse,
  SearchResultResponse,
  SwipeRequest,
  AttachmentResponse
} from '../../../preload/index.d'

export type {
  ChatResponse,
  MessageResponse,
  SendMessageResponse,
  SyncStatusResponse,
  ActionResponse,
  SearchResultResponse,
  AttachmentResponse
}

// Backend URL for direct HTTP calls (browser dev mode)
export const API_BASE = 'http://localhost:8000'

// Check if running in Electron (window.api is defined by preload script)
const isElectron = () => typeof window !== 'undefined' && window.api !== undefined

// Helper for direct HTTP calls
async function httpGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
  return res.json()
}

async function httpPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
  return res.json()
}

// API functions with Electron IPC / HTTP fallback

export async function fetchChats(limit = 50, offset = 0): Promise<ChatResponse[]> {
  if (isElectron()) {
    return window.api.getChats(limit, offset)
  }
  return httpGet(`/chats/?limit=${limit}&offset=${offset}`)
}

export async function fetchMessages(chatId: number, limit = 100): Promise<MessageResponse[]> {
  if (isElectron()) {
    return window.api.getMessages(chatId, limit)
  }
  return httpGet(`/chats/${chatId}/messages?limit=${limit}`)
}

export async function sendMessage(chatId: number, text: string): Promise<SendMessageResponse> {
  if (isElectron()) {
    return window.api.sendMessage(chatId, text)
  }
  return httpPost(`/chats/${chatId}/messages`, { text })
}

export async function fetchSyncStatus(): Promise<SyncStatusResponse> {
  if (isElectron()) {
    return window.api.getSyncStatus()
  }
  return httpGet('/sync/status')
}

export async function fetchActions(
  status = 'pending',
  limit = 50,
  actionType?: string
): Promise<ActionResponse[]> {
  if (isElectron()) {
    return window.api.getActions(status, limit, actionType)
  }
  let url = `/actions/?status=${status}&limit=${limit}`
  if (actionType) {
    url += `&action_type=${actionType}`
  }
  return httpGet(url)
}

export async function fetchActionsCount(actionType?: string): Promise<number> {
  if (isElectron()) {
    return window.api.getActionsCount(actionType)
  }
  let url = '/actions/count'
  if (actionType) {
    url += `?action_type=${actionType}`
  }
  const response = await httpGet<{ count: number }>(url)
  return response.count
}

export async function swipeAction(
  actionId: number,
  request: SwipeRequest
): Promise<ActionResponse> {
  if (isElectron()) {
    return window.api.swipeAction(actionId, request)
  }
  return httpPost(`/actions/${actionId}/swipe`, request)
}

export async function fetchActionMessages(
  actionId: number,
  limit = 15,
  offset = 0
): Promise<MessageResponse[]> {
  if (isElectron()) {
    return window.api.getActionMessages(actionId, limit, offset)
  }
  return httpGet(`/actions/${actionId}/messages?limit=${limit}&offset=${offset}`)
}

export async function searchMessages(query: string, limit = 50): Promise<SearchResultResponse[]> {
  if (isElectron()) {
    return window.api.searchMessages(query, limit)
  }
  return httpGet(`/search/?query=${encodeURIComponent(query)}&limit=${limit}`)
}

export async function addContactContext(
  personId: number,
  notes: string
): Promise<{ success: boolean }> {
  if (isElectron()) {
    return window.api.addContactContext(personId, notes)
  }
  return httpPost(`/eod/contacts/${personId}/context?notes=${encodeURIComponent(notes)}`)
}
