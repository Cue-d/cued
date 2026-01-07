export interface ChatResponse {
  id: number
  name: string
  last_message: string | null
  last_message_date: number
  is_group: boolean
  handle_ids: string[]
  member_names: string[]
}

export interface AttachmentResponse {
  id: number
  filename: string | null
  mime_type: string | null
  size: number | null
  is_image: boolean
}

export interface MessageResponse {
  id: number
  text: string | null
  date: number
  is_from_me: boolean
  is_read: boolean
  date_read: number | null
  sender_name: string | null
  // Delivery status
  is_sent: boolean
  is_delivered: boolean
  date_delivered: number | null
  error: number
  // Attachments
  attachments: AttachmentResponse[]
}

export interface SendMessageResponse {
  success: boolean
  error: string | null
}

export interface SyncStatusResponse {
  is_syncing: boolean
  initial_sync_complete: boolean
  last_sync_at: number | null
  last_sync_duration: number | null
  last_error: string | null
}

export interface ActionResponse {
  id: number
  type: 'respond_to_message' | 'eod_contact' | 'follow_up'
  status: 'pending' | 'completed' | 'discarded' | 'snoozed'
  priority: number
  chat_id: number | null
  person_id: number | null
  message_id: number | null
  payload: Record<string, unknown> | null
  created_at: number
  remind_at: number | null
  snoozed_until: number | null
  completed_at: number | null
  discarded_at: number | null
  chat_name: string | null
  person_name: string | null
  message_text: string | null
  message_timestamp: number | null
  recent_messages: MessageResponse[]
}

export interface SearchResultResponse {
  message_id: number
  chat_id: number
  text: string
  timestamp: number
  sender_name: string | null
  chat_name: string | null
  rank: number
}

export interface SwipeRequest {
  direction: 'left' | 'right' | 'up'
  snooze_minutes?: number
  response_text?: string
}

export interface Api {
  getChats: (limit?: number, offset?: number) => Promise<ChatResponse[]>
  getMessages: (chatId: number, limit?: number) => Promise<MessageResponse[]>
  sendMessage: (chatId: number, text: string) => Promise<SendMessageResponse>
  getSyncStatus: () => Promise<SyncStatusResponse>
  getActions: (status?: string, limit?: number, actionType?: string) => Promise<ActionResponse[]>
  swipeAction: (actionId: number, request: SwipeRequest) => Promise<ActionResponse>
  searchMessages: (query: string, limit?: number) => Promise<SearchResultResponse[]>
  semanticSearch: (query: string, limit?: number) => Promise<SearchResultResponse[]>
  addContactContext: (personId: number, notes: string) => Promise<{ success: boolean }>
}

declare global {
  interface Window {
    api: Api
  }
}
