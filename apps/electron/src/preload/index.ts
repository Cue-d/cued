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
  social: {
    // LinkedIn - Contact Scraping
    linkedinStatus: (): Promise<unknown> => ipcRenderer.invoke('social:linkedin:status'),
    linkedinLogin: (): Promise<unknown> => ipcRenderer.invoke('social:linkedin:login'),
    linkedinScrape: (options?: { maxConnections?: number }): Promise<unknown> =>
      ipcRenderer.invoke('social:linkedin:scrape', options),

    // LinkedIn - Messaging Sync
    linkedinMessagingStatus: (): Promise<unknown> =>
      ipcRenderer.invoke('social:linkedin:messagingStatus'),
    linkedinStartMessagingSync: (): Promise<unknown> =>
      ipcRenderer.invoke('social:linkedin:startMessagingSync'),
    linkedinStopMessagingSync: (): Promise<unknown> =>
      ipcRenderer.invoke('social:linkedin:stopMessagingSync'),
    linkedinSendMessage: (conversationId: string, text: string): Promise<unknown> =>
      ipcRenderer.invoke('social:linkedin:sendMessage', conversationId, text),
    linkedinGetSyncProgress: (): Promise<unknown> =>
      ipcRenderer.invoke('social:linkedin:getSyncProgress'),

    // Twitter
    twitterStatus: (): Promise<unknown> => ipcRenderer.invoke('social:twitter:status'),
    twitterLogin: (): Promise<unknown> => ipcRenderer.invoke('social:twitter:login'),
    twitterScrapeMutuals: (username: string, options?: { maxUsers?: number }): Promise<unknown> =>
      ipcRenderer.invoke('social:twitter:scrapeMutuals', username, options),

    // Progress listeners - LinkedIn
    onLinkedinProgress: (callback: (progress: unknown) => void) => {
      const handler = (_event: IpcRendererEvent, progress: unknown) => callback(progress)
      ipcRenderer.on('social:linkedin:scrapeProgress', handler)
      return () => ipcRenderer.removeListener('social:linkedin:scrapeProgress', handler)
    },
    onLinkedinMessagingSyncProgress: (callback: (progress: unknown) => void) => {
      const handler = (_event: IpcRendererEvent, progress: unknown) => callback(progress)
      ipcRenderer.on('social:linkedin:messagingSyncProgress', handler)
      return () => ipcRenderer.removeListener('social:linkedin:messagingSyncProgress', handler)
    },
    onLinkedinAuthInvalid: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('social:linkedin:authInvalid', handler)
      return () => ipcRenderer.removeListener('social:linkedin:authInvalid', handler)
    },

    // Progress listeners - Twitter
    onTwitterProgress: (callback: (progress: unknown) => void) => {
      const handler = (_event: IpcRendererEvent, progress: unknown) => callback(progress)
      ipcRenderer.on('social:twitter:scrapeProgress', handler)
      return () => ipcRenderer.removeListener('social:twitter:scrapeProgress', handler)
    },

    // Slack - Native Integration (Task 5.1) - Multi-workspace support
    slackStatus: (): Promise<unknown> => ipcRenderer.invoke('social:slack:status'),
    slackLogin: (): Promise<unknown> => ipcRenderer.invoke('social:slack:login'),
    slackDisconnect: (teamId?: string): Promise<unknown> =>
      ipcRenderer.invoke('social:slack:disconnect', teamId),
    slackListWorkspaces: (): Promise<unknown> =>
      ipcRenderer.invoke('social:slack:listWorkspaces'),

    // Slack - Messaging Sync (supports optional teamId for specific workspace)
    slackMessagingStatus: (): Promise<unknown> =>
      ipcRenderer.invoke('social:slack:messagingStatus'),
    slackStartMessagingSync: (teamId?: string): Promise<unknown> =>
      ipcRenderer.invoke('social:slack:startMessagingSync', teamId),
    slackStopMessagingSync: (teamId?: string): Promise<unknown> =>
      ipcRenderer.invoke('social:slack:stopMessagingSync', teamId),
    slackGetSyncProgress: (): Promise<unknown> =>
      ipcRenderer.invoke('social:slack:getSyncProgress'),

    // Progress listeners - Slack
    onSlackMessagingSyncProgress: (callback: (progress: unknown) => void) => {
      const handler = (_event: IpcRendererEvent, progress: unknown) => callback(progress)
      ipcRenderer.on('social:slack:messagingSyncProgress', handler)
      return () => ipcRenderer.removeListener('social:slack:messagingSyncProgress', handler)
    },
    onSlackAuthInvalid: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('social:slack:authInvalid', handler)
      return () => ipcRenderer.removeListener('social:slack:authInvalid', handler)
    },
  },
})
