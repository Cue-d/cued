export interface ConversationResponse {
  id: number
  name: string
  last_message: string | null
  last_message_date: number
  is_group: boolean
  handle_ids: string[]
}

export interface MessageResponse {
  id: number
  text: string | null
  date: number
  is_from_me: boolean
  sender_name: string | null
}

export interface Api {
  getConversations: (limit?: number) => Promise<ConversationResponse[]>
  getMessages: (chatId: number, limit?: number) => Promise<MessageResponse[]>
}

declare global {
  interface Window {
    api: Api
  }
}
