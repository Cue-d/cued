import { contextBridge, ipcRenderer } from 'electron'

// Custom APIs for renderer
const api = {
  getConversations: (limit?: number) => ipcRenderer.invoke('api:getConversations', limit),
  getMessages: (chatId: number, limit?: number) => ipcRenderer.invoke('api:getMessages', chatId, limit)
}

// Expose APIs to renderer
contextBridge.exposeInMainWorld('api', api)
