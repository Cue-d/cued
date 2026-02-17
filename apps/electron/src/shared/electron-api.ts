/**
 * Shared type definitions for the Electron IPC bridge.
 *
 * Used by both the preload script (to type the exposed API)
 * and the renderer (to type window.electron).
 */

// Auth types
export interface AuthUser {
  email: string
  firstName: string | null
  id: string
  lastName: string | null
}

export interface AuthState {
  isAuthenticated: boolean
  user: AuthUser | null
}

// Sync types
export interface PlatformSyncResult {
  contacts?: { synced: number; updated: number }
  imessage?: { messages: number }
  linkedin?: { contacts: number; messages: number }
  twitter?: { contacts: number; messages: number }
  signal?: { contacts: number; messages: number }
  slack?: { messages: number; workspaces: number }
}

export interface UnifiedSyncProgress {
  currentPlatform?: "contacts" | "imessage" | "linkedin" | "twitter" | "twitter_contacts" | "linkedin_contacts" | "signal" | "signal_contacts" | "slack"
  error?: string
  lastSyncAt?: number
  platforms: PlatformSyncResult
  status: "error" | "idle" | "syncing"
}

export interface UnifiedSyncResult {
  error?: string
  platforms: PlatformSyncResult
  skipped?: boolean
  success: boolean
}

// LinkedIn types
export interface LinkedInStatusResult {
  error?: string
  isLoggedIn: boolean
}

export interface LinkedInSyncProgress {
  error?: string
  lastSyncAt?: number
  realtimeConnected: boolean
  status: "error" | "idle" | "realtime" | "syncing"
  totalConversationsSynced: number
  totalMessagesSynced: number
}

export interface LinkedInSendMessageResult {
  error?: string
  messageId?: string
  success: boolean
}

// Twitter types
export interface TwitterStatusResult {
  error?: string
  isLoggedIn: boolean
}

export interface TwitterSyncProgress {
  error?: string
  lastSyncAt?: number
  status: "error" | "idle" | "syncing"
  totalConversationsSynced: number
  totalMessagesSynced: number
  totalContactsSynced: number
}

export interface TwitterSendMessageResult {
  error?: string
  messageId?: string
  success: boolean
}

// Signal types
export interface SignalStatusResult {
  error?: string
  isLoggedIn: boolean
}

export interface SignalSyncProgress {
  error?: string
  lastSyncAt?: number
  status: "error" | "idle" | "syncing"
  totalMessagesSynced: number
}

export interface SignalSendMessageResult {
  error?: string
  messageId?: string
  success: boolean
}

export interface SignalLoginCredentials {
  cliPath?: string
}

export interface SignalValidationStep {
  step: "java" | "install" | "link"
  status: "pending" | "running" | "success" | "error"
  error?: string
}

export interface SignalSetupResult {
  success: boolean
  cliPath?: string
  steps: SignalValidationStep[]
  error?: string
}

export interface SignalLoginResult {
  success: boolean
  isLoggedIn: boolean
  steps?: SignalValidationStep[]
  error?: string
}

// Slack types
export interface SlackSyncProgress {
  error?: string
  lastSyncAt?: number
  status: "error" | "idle" | "syncing"
  teamId?: string
  teamName?: string
  totalConversationsSynced: number
  totalMessagesSynced: number
}

export interface SlackWorkspaceInfo {
  isConnected: boolean
  syncProgress?: SlackSyncProgress
  teamId: string
  teamName: string
  userId: string
}

export interface SlackStatusResult {
  error?: string
  isConnected: boolean
  teamName?: string
  workspaces?: SlackWorkspaceInfo[]
}

export interface SlackLoginResult {
  error?: string
  success: boolean
  teamId?: string
  teamName?: string
}

export interface SlackDisconnectResult {
  error?: string
  success: boolean
}

// Permission types
export interface PermissionStatus {
  fullDiskAccess: boolean
  contacts: boolean
}

// Auto-updater types
export interface UpdaterStatus {
  status: "downloading" | "ready" | "error"
  version?: string
}

/**
 * The complete Electron API exposed to the renderer via contextBridge.
 */
export interface ElectronAPI {
  settings: {
    getSyncHistoryDays: () => Promise<number>
    setSyncHistoryDays: (days: number) => Promise<number>
    getOnboardingCompleted: () => Promise<boolean>
    setOnboardingCompleted: (completed: boolean) => Promise<boolean>
  }

  versions: {
    node: () => string
    chrome: () => string
    electron: () => string
  }

  config: {
    getConvexUrl: () => Promise<string>
    getAccessToken: (forceRefresh?: boolean) => Promise<string | null>
    getAppUrl: () => Promise<string>
  }

  shell: {
    openExternal: (url: string) => Promise<boolean>
  }

  auth: {
    getState: () => Promise<AuthState>
    startLogin: () => Promise<void>
    signOut: () => Promise<void>
    onAuthChange: (callback: (state: AuthState) => void) => () => void
    onUserCode: (callback: (code: string, uri: string) => void) => () => void
  }

  updater: {
    onStatus: (callback: (status: UpdaterStatus) => void) => () => void
    quitAndInstall: () => Promise<void>
  }

  permissions: {
    check: () => Promise<PermissionStatus>
    openFullDiskAccessSettings: () => Promise<void>
    openContactsSettings: () => Promise<void>
  }

  sync: {
    runAll: () => Promise<UnifiedSyncResult>
    runNow: () => Promise<UnifiedSyncResult>
    getProgress: () => Promise<UnifiedSyncProgress>
    onProgress: (callback: (progress: UnifiedSyncProgress) => void) => () => void

    linkedin: {
      status: () => Promise<LinkedInStatusResult>
      login: () => Promise<LinkedInStatusResult>
      logout: () => Promise<{ error?: string; success: boolean }>
      sendMessage: (conversationId: string, text: string) => Promise<LinkedInSendMessageResult>
      getProgress: () => Promise<LinkedInSyncProgress>
    }

    twitter: {
      status: () => Promise<TwitterStatusResult>
      login: () => Promise<TwitterStatusResult>
      logout: () => Promise<{ error?: string; success: boolean }>
      sendMessage: (conversationId: string, text: string) => Promise<TwitterSendMessageResult>
      getProgress: () => Promise<TwitterSyncProgress>
    }

    slack: {
      status: () => Promise<SlackStatusResult>
      login: () => Promise<SlackLoginResult>
      disconnect: (teamId?: string) => Promise<SlackDisconnectResult>
      listWorkspaces: () => Promise<{ workspaces: SlackWorkspaceInfo[] }>
      getProgress: () => Promise<SlackSyncProgress>
    }

    signal: {
      status: () => Promise<SignalStatusResult>
      setup: (credentials?: SignalLoginCredentials) => Promise<SignalSetupResult>
      openLinkTerminal: (cliPath: string) => Promise<{ success: boolean; error?: string }>
      checkLink: (cliPath: string) => Promise<SignalLoginResult>
      logout: () => Promise<{ error?: string; success: boolean }>
      sendMessage: (threadOrRecipient: string, text: string) => Promise<SignalSendMessageResult>
      getProgress: () => Promise<SignalSyncProgress>
    }
  }
}
