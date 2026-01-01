import { contextBridge, ipcRenderer } from 'electron'

// Custom APIs for renderer
const api = {
  getConversations: (limit?: number, offset?: number) =>
    ipcRenderer.invoke('api:getConversations', limit, offset),
  getMessages: (chatId: number, limit?: number) =>
    ipcRenderer.invoke('api:getMessages', chatId, limit),
  sendMessage: (chatId: number, text: string) => ipcRenderer.invoke('api:sendMessage', chatId, text)
}

// Expose APIs to renderer
contextBridge.exposeInMainWorld('api', api)
