import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electron', {
  versions: {
    node: () => process.versions.node,
    chrome: () => process.versions.chrome,
    electron: () => process.versions.electron,
  },
  auth: {
    // Get current auth state
    getState: (): Promise<unknown> => ipcRenderer.invoke('auth:getState'),
    // Start device authorization flow
    startLogin: (): Promise<void> => ipcRenderer.invoke('auth:startLogin'),
    // Sign out
    signOut: (): Promise<void> => ipcRenderer.invoke('auth:signOut'),
    // Listen for auth state changes
    onAuthChange: (callback: (state: unknown) => void) => {
      const handler = (_event: IpcRendererEvent, state: unknown) => callback(state)
      ipcRenderer.on('auth:stateChanged', handler)
      return () => ipcRenderer.removeListener('auth:stateChanged', handler)
    },
    // Listen for user code display (during device auth)
    onUserCode: (callback: (code: string, uri: string) => void) => {
      const handler = (_event: IpcRendererEvent, code: string, uri: string) => callback(code, uri)
      ipcRenderer.on('auth:userCode', handler)
      return () => ipcRenderer.removeListener('auth:userCode', handler)
    },
  },
  sync: {
    // ============================================================================
    // iMessage Sync
    // ============================================================================
    imessage: {
      getProgress: (): Promise<unknown> => ipcRenderer.invoke('sync:imessage:getProgress'),
      runNow: (): Promise<unknown> => ipcRenderer.invoke('sync:imessage:runNow'),
      reset: (): Promise<unknown> => ipcRenderer.invoke('sync:imessage:reset'),
      forceFullSync: (): Promise<unknown> => ipcRenderer.invoke('sync:imessage:forceFullSync'),
      onProgress: (callback: (progress: unknown) => void) => {
        const handler = (_event: IpcRendererEvent, progress: unknown) => callback(progress)
        ipcRenderer.on('sync:imessage:progress', handler)
        return () => ipcRenderer.removeListener('sync:imessage:progress', handler)
      },
    },

    // ============================================================================
    // LinkedIn Sync
    // ============================================================================
    linkedin: {
      // Connection status
      status: (): Promise<unknown> => ipcRenderer.invoke('sync:linkedin:status'),
      login: (): Promise<unknown> => ipcRenderer.invoke('sync:linkedin:login'),
      scrape: (options?: { maxConnections?: number }): Promise<unknown> =>
        ipcRenderer.invoke('sync:linkedin:scrape', options),

      // Messaging sync
      messagingStatus: (): Promise<unknown> => ipcRenderer.invoke('sync:linkedin:messagingStatus'),
      start: (): Promise<unknown> => ipcRenderer.invoke('sync:linkedin:start'),
      stop: (): Promise<unknown> => ipcRenderer.invoke('sync:linkedin:stop'),
      sendMessage: (conversationId: string, text: string): Promise<unknown> =>
        ipcRenderer.invoke('sync:linkedin:sendMessage', conversationId, text),
      getProgress: (): Promise<unknown> => ipcRenderer.invoke('sync:linkedin:getProgress'),

      // Progress listeners
      onProgress: (callback: (progress: unknown) => void) => {
        const handler = (_event: IpcRendererEvent, progress: unknown) => callback(progress)
        ipcRenderer.on('sync:linkedin:progress', handler)
        return () => ipcRenderer.removeListener('sync:linkedin:progress', handler)
      },
      onScrapeProgress: (callback: (progress: unknown) => void) => {
        const handler = (_event: IpcRendererEvent, progress: unknown) => callback(progress)
        ipcRenderer.on('sync:linkedin:scrapeProgress', handler)
        return () => ipcRenderer.removeListener('sync:linkedin:scrapeProgress', handler)
      },
      onAuthInvalid: (callback: () => void) => {
        const handler = () => callback()
        ipcRenderer.on('sync:linkedin:authInvalid', handler)
        return () => ipcRenderer.removeListener('sync:linkedin:authInvalid', handler)
      },
    },

    // ============================================================================
    // Slack Sync
    // ============================================================================
    slack: {
      // Connection status
      status: (): Promise<unknown> => ipcRenderer.invoke('sync:slack:status'),
      login: (): Promise<unknown> => ipcRenderer.invoke('sync:slack:login'),
      disconnect: (teamId?: string): Promise<unknown> =>
        ipcRenderer.invoke('sync:slack:disconnect', teamId),
      listWorkspaces: (): Promise<unknown> => ipcRenderer.invoke('sync:slack:listWorkspaces'),

      // Messaging sync
      messagingStatus: (): Promise<unknown> => ipcRenderer.invoke('sync:slack:messagingStatus'),
      start: (teamId?: string): Promise<unknown> => ipcRenderer.invoke('sync:slack:start', teamId),
      stop: (teamId?: string): Promise<unknown> => ipcRenderer.invoke('sync:slack:stop', teamId),
      getProgress: (): Promise<unknown> => ipcRenderer.invoke('sync:slack:getProgress'),

      // Progress listeners
      onProgress: (callback: (progress: unknown) => void) => {
        const handler = (_event: IpcRendererEvent, progress: unknown) => callback(progress)
        ipcRenderer.on('sync:slack:progress', handler)
        return () => ipcRenderer.removeListener('sync:slack:progress', handler)
      },
      onAuthInvalid: (callback: () => void) => {
        const handler = () => callback()
        ipcRenderer.on('sync:slack:authInvalid', handler)
        return () => ipcRenderer.removeListener('sync:slack:authInvalid', handler)
      },
    },
  },
})
