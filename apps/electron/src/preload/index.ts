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
    // Get current sync progress
    getProgress: (): Promise<unknown> => ipcRenderer.invoke('sync:getProgress'),
    // Run sync now
    runNow: (): Promise<unknown> => ipcRenderer.invoke('sync:runNow'),
    // Reset cursor (local only)
    reset: (): Promise<unknown> => ipcRenderer.invoke('sync:reset'),
    // Force full sync (resets server + local state, re-syncs messages + contacts)
    forceFullSync: (): Promise<unknown> => ipcRenderer.invoke('sync:forceFullSync'),
    // Listen for sync progress updates
    onProgress: (callback: (progress: unknown) => void) => {
      const handler = (_event: IpcRendererEvent, progress: unknown) => callback(progress)
      ipcRenderer.on('sync:progress', handler)
      return () => ipcRenderer.removeListener('sync:progress', handler)
    },
  },
})
