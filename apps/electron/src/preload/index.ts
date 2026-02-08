import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";
import type {
  AuthState,
  ElectronAPI,
  LinkedInSendMessageResult,
  LinkedInStatusResult,
  LinkedInSyncProgress,
  SignalLoginCredentials,
  SignalLoginResult,
  SignalSendMessageResult,
  SignalSetupResult,
  SignalStatusResult,
  SignalSyncProgress,
  SlackDisconnectResult,
  SlackLoginResult,
  SlackStatusResult,
  SlackSyncProgress,
  SlackWorkspaceInfo,
  UnifiedSyncProgress,
  UnifiedSyncResult,
} from "../shared/electron-api";

const api: ElectronAPI = {
  versions: {
    node: () => process.versions.node,
    chrome: () => process.versions.chrome,
    electron: () => process.versions.electron,
  },

  config: {
    getConvexUrl: (): Promise<string> => ipcRenderer.invoke("config:getConvexUrl"),
    getAccessToken: (): Promise<string | null> => ipcRenderer.invoke("auth:getAccessToken"),
    getAppUrl: (): Promise<string> => ipcRenderer.invoke("config:getAppUrl"),
  },

  shell: {
    openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke("shell:openExternal", url),
  },

  auth: {
    getState: (): Promise<AuthState> => ipcRenderer.invoke("auth:getState"),
    startLogin: (): Promise<void> => ipcRenderer.invoke("auth:startLogin"),
    signOut: (): Promise<void> => ipcRenderer.invoke("auth:signOut"),
    onAuthChange: (callback: (state: AuthState) => void) => {
      const handler = (_event: IpcRendererEvent, state: AuthState) => callback(state);
      ipcRenderer.on("auth:stateChanged", handler);
      return () => ipcRenderer.removeListener("auth:stateChanged", handler);
    },
    onUserCode: (callback: (code: string, uri: string) => void) => {
      const handler = (_event: IpcRendererEvent, code: string, uri: string) => callback(code, uri);
      ipcRenderer.on("auth:userCode", handler);
      return () => ipcRenderer.removeListener("auth:userCode", handler);
    },
  },

  sync: {
    // Unified sync (all platforms)
    runAll: (): Promise<UnifiedSyncResult> => ipcRenderer.invoke("sync:runAll"),
    runNow: (): Promise<UnifiedSyncResult> => ipcRenderer.invoke("sync:runNow"),
    getProgress: (): Promise<UnifiedSyncProgress> => ipcRenderer.invoke("sync:getProgress"),
    onProgress: (callback: (progress: UnifiedSyncProgress) => void) => {
      const handler = (_event: IpcRendererEvent, progress: UnifiedSyncProgress) => callback(progress);
      ipcRenderer.on("sync:progress", handler);
      return () => ipcRenderer.removeListener("sync:progress", handler);
    },

    // LinkedIn
    linkedin: {
      status: (): Promise<LinkedInStatusResult> => ipcRenderer.invoke("sync:linkedin:status"),
      login: (): Promise<LinkedInStatusResult> => ipcRenderer.invoke("sync:linkedin:login"),
      logout: (): Promise<{ error?: string; success: boolean }> => ipcRenderer.invoke("sync:linkedin:logout"),
      sendMessage: (conversationId: string, text: string): Promise<LinkedInSendMessageResult> =>
        ipcRenderer.invoke("sync:linkedin:sendMessage", conversationId, text),
      getProgress: (): Promise<LinkedInSyncProgress> => ipcRenderer.invoke("sync:linkedin:getProgress"),
    },

    // Slack
    slack: {
      status: (): Promise<SlackStatusResult> => ipcRenderer.invoke("sync:slack:status"),
      login: (): Promise<SlackLoginResult> => ipcRenderer.invoke("sync:slack:login"),
      disconnect: (teamId?: string): Promise<SlackDisconnectResult> =>
        ipcRenderer.invoke("sync:slack:disconnect", teamId),
      listWorkspaces: (): Promise<{ workspaces: SlackWorkspaceInfo[] }> => ipcRenderer.invoke("sync:slack:listWorkspaces"),
      getProgress: (): Promise<SlackSyncProgress> => ipcRenderer.invoke("sync:slack:getProgress"),
    },

    // Signal
    signal: {
      status: (): Promise<SignalStatusResult> => ipcRenderer.invoke("sync:signal:status"),
      setup: (credentials?: SignalLoginCredentials): Promise<SignalSetupResult> =>
        ipcRenderer.invoke("sync:signal:setup", credentials),
      openLinkTerminal: (cliPath: string): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke("sync:signal:openLinkTerminal", cliPath),
      checkLink: (cliPath: string): Promise<SignalLoginResult> =>
        ipcRenderer.invoke("sync:signal:checkLink", cliPath),
      logout: (): Promise<{ error?: string; success: boolean }> => ipcRenderer.invoke("sync:signal:logout"),
      sendMessage: (threadOrRecipient: string, text: string): Promise<SignalSendMessageResult> =>
        ipcRenderer.invoke("sync:signal:sendMessage", threadOrRecipient, text),
      getProgress: (): Promise<SignalSyncProgress> => ipcRenderer.invoke("sync:signal:getProgress"),
    },
  },
};

contextBridge.exposeInMainWorld("electron", api);
