export interface ChatResponse {
  id: number
  name: string
  last_message: string | null
  last_message_date: number
  is_group: boolean
  handle_ids: string[]
  member_names: string[]
}

export interface MessageResponse {
  id: number
  text: string | null
  date: number
  is_from_me: boolean
  is_read: boolean
  date_read: number | null
  sender_name: string | null
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

export interface Api {
  getChats: (limit?: number, offset?: number) => Promise<ChatResponse[]>
  getMessages: (chatId: number, limit?: number) => Promise<MessageResponse[]>
  sendMessage: (chatId: number, text: string) => Promise<SendMessageResponse>
  getSyncStatus: () => Promise<SyncStatusResponse>
}

declare global {
  interface Window {
    api: Api
  }
}
