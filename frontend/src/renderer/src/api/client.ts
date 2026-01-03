export type { ChatResponse, MessageResponse, SendMessageResponse } from '../../../preload/index.d'

export async function fetchChats(limit = 50, offset = 0) {
  return window.api.getChats(limit, offset)
}

export async function fetchMessages(chatId: number, limit = 100) {
  return window.api.getMessages(chatId, limit)
}

export async function sendMessage(chatId: number, text: string) {
  return window.api.sendMessage(chatId, text)
}
