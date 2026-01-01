export type {
  ConversationResponse,
  MessageResponse,
  SendMessageResponse
} from '../../../preload/index.d'

export async function fetchConversations(limit = 50, offset = 0) {
  return window.api.getConversations(limit, offset)
}

export async function fetchMessages(chatId: number, limit = 100) {
  return window.api.getMessages(chatId, limit)
}

export async function sendMessage(chatId: number, text: string) {
  return window.api.sendMessage(chatId, text)
}
