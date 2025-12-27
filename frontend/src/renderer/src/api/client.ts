export type { ConversationResponse, MessageResponse, SendMessageResponse } from '../../../preload/index.d'

export async function fetchConversations(limit = 50) {
  return window.api.getConversations(limit)
}

export async function fetchMessages(chatId: number, limit = 100) {
  return window.api.getMessages(chatId, limit)
}

export async function sendMessage(chatId: number, text: string) {
  return window.api.sendMessage(chatId, text)
}
