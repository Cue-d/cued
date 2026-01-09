import { contextBridge, ipcRenderer } from 'electron'
import type { SwipeRequest } from './index.d'

// Custom APIs for renderer
const api = {
  getChats: (limit?: number, offset?: number) => ipcRenderer.invoke('api:getChats', limit, offset),
  getMessages: (chatId: number, limit?: number) =>
    ipcRenderer.invoke('api:getMessages', chatId, limit),
  sendMessage: (chatId: number, text: string) =>
    ipcRenderer.invoke('api:sendMessage', chatId, text),
  getSyncStatus: () => ipcRenderer.invoke('api:getSyncStatus'),
  getActions: (status?: string, limit?: number, actionType?: string) =>
    ipcRenderer.invoke('api:getActions', status, limit, actionType),
  swipeAction: (actionId: number, request: SwipeRequest) =>
    ipcRenderer.invoke('api:swipeAction', actionId, request),
  getActionMessages: (actionId: number, limit?: number, offset?: number) =>
    ipcRenderer.invoke('api:getActionMessages', actionId, limit, offset),
  searchMessages: (query: string, limit?: number) =>
    ipcRenderer.invoke('api:searchMessages', query, limit),
  addContactContext: (personId: number, notes: string) =>
    ipcRenderer.invoke('api:addContactContext', personId, notes)
}

// Expose APIs to renderer
contextBridge.exposeInMainWorld('api', api)
