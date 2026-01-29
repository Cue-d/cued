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
    // Unified Sync (runs all platforms)
    // ============================================================================
    runAll: (): Promise<unknown> => ipcRenderer.invoke('sync:runAll'),
    runNow: (): Promise<unknown> => ipcRenderer.invoke('sync:runNow'),
    getProgress: (): Promise<unknown> => ipcRenderer.invoke('sync:getProgress'),
    onProgress: (callback: (progress: unknown) => void) => {
      const handler = (_event: IpcRendererEvent, progress: unknown) => callback(progress)
      ipcRenderer.on('sync:progress', handler)
      return () => ipcRenderer.removeListener('sync:progress', handler)
    },

    // ============================================================================
    // LinkedIn (Login/Status/SendMessage only)
    // ============================================================================
    linkedin: {
      status: (): Promise<unknown> => ipcRenderer.invoke('sync:linkedin:status'),
      login: (): Promise<unknown> => ipcRenderer.invoke('sync:linkedin:login'),
      logout: (): Promise<unknown> => ipcRenderer.invoke('sync:linkedin:logout'),
      sendMessage: (conversationId: string, text: string): Promise<unknown> =>
        ipcRenderer.invoke('sync:linkedin:sendMessage', conversationId, text),
      getProgress: (): Promise<unknown> => ipcRenderer.invoke('sync:linkedin:getProgress'),
    },

    // ============================================================================
    // Slack (Login/Status/Disconnect only)
    // ============================================================================
    slack: {
      status: (): Promise<unknown> => ipcRenderer.invoke('sync:slack:status'),
      login: (): Promise<unknown> => ipcRenderer.invoke('sync:slack:login'),
      disconnect: (teamId?: string): Promise<unknown> =>
        ipcRenderer.invoke('sync:slack:disconnect', teamId),
      listWorkspaces: (): Promise<unknown> => ipcRenderer.invoke('sync:slack:listWorkspaces'),
      getProgress: (): Promise<unknown> => ipcRenderer.invoke('sync:slack:getProgress'),
    },
  },
})
